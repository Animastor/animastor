# Animastor — Redis Failure & Recovery Model (Recon #2)

> **Cathedral Project — Recon #2 · Redis Failure & Recovery Audit**
> Date: August 2026 · Method: code-first trace of every recovery path; deployment config inspected; **no code changed**.
> Scenario under study: **Redis = empty/lost, PostgreSQL = intact, filesystem = intact, workers = potentially running, backend = restarted**.
>
> Companion docs: `architecture-map.md` (system), `audit.md` (Recon #1). This document answers the single question: *what actually happens to Animastor if Redis disappears?*

---

## 1. Current architecture — how Redis is used

One stock `redis:7` container, shared by backend **and** GPU Hub (same instance, `docker-compose.yml`). Redis is:

1. **Runtime source of truth for the generation lifecycle** — `animastor:asset-state:{b}:{ch}:{sc}` (hash, audio/image/video).
2. **The scheduler's work list** — `animastor:active-scenes` (set). **The scheduler only processes members of this set.**
3. **Dispatch coordination** — leases (`dispatch-lease:*`), dispatch metadata (`dispatch-meta:*`), idempotency markers (`dispatch-completed:*`), quota counters (`runtime:active-*`), retry budgets (`runtime:retry:*`), tick lock (`runtime:scheduler-lock`).
4. **Layer state machines** — `audio-orch:*`, `video-orch:*`.
5. **GPU transport** — hub queues (`queue:{type}`, `processing`, `running`), enqueue dedup (`job:{dispatch_id}:{job_id}`), result/error mailboxes (`result:*`, `error:*`), worker registry/heartbeats (`gpu-hub:workers`, `worker:heartbeat:*`).
6. **Data flags** — chunk metadata (`chunk:*`, `chunks:{book}`), IU progress (`iu-progress:*`, `iu-in-flight:*`), window counters (`book-scenes:{book}:total|next-index|window-start`), layer-config, gen-scope, cancel/force flags, event journal (`event-journal:*`).

PostgreSQL is the **persistent anchor** (books, `scenes` versions + `is_dirty` + `dirty_unit_ids`, `scene_assets` file records, generation tasks, agent pipeline, events). The filesystem holds the **artifacts** (mp3/mp4/png) + book JSON.

---

## 2. Deployment config (verified, `docker-compose.yml`)

| Property | Value | Consequence |
|---|---|---|
| Image | `redis:7` (stock, no custom config file in repo — confirmed by glob: no `redis.conf` anywhere) | Defaults apply |
| Persistence | Volume `redis-data:/data`; **RDB default only** (`save 3600 1 / 300 100 / 60 10000`); **no AOF** (`--appendonly` not set) | Restart restores from last RDB snapshot (≤ ~1 min stale under generation write load); up to 3600 s stale when writes are sparse |
| HA | **None** — no replica, no Sentinel, no Cluster | Node loss ⇒ full runtime unavailability until the node returns |
| Eviction | No `maxmemory` set → default `noeviction` | No LRU eviction; keys live until TTL |
| Restart policy | `restart: unless-stopped` (all services) | Container crash auto-restarts; data survives if volume intact |
| Health | `redis-cli ping` healthcheck; backend/gpu-hub `depends_on: service_healthy` | Backend won't start until Redis is *reachable* — but if the volume is gone and Redis comes up empty, the backend starts normally with an empty runtime and **scenario C applies** |

**Answer (task §5):** restarting the Redis container → runtime state is **mostly preserved** (RDB on the volume), so losing runtime state on a plain restart is **unlikely**. If loss happens anyway, the system does **not** rely on Redis persistence — it relies on reconciliation *partially*, and on **client-triggered recovery** for the work list (see §4).

---

## 3. Failure scenarios

### A. Redis process restart (data intact)

- RDB loaded from `/data/dump.rdb` (volume) — runtime state returns, potentially stale by up to the last snapshot.
- All TTL-based keys re-start their TTL clocks from now; keys that expired *while Redis was down* are gone (leases, heartbeats, mailboxes, 1 h dedup keys — all short-TTL).
- On backend startup: `backend.cjs` deletes **all** dispatch leases anyway, resets active counters, runs the startup reconcile cycle.
- **Effect:** near-zero visible impact. In-flight dispatch leases are gone by design → a scene whose GPU job survived is re-dispatched once the work list is processed (duplicate generation, overwritten artifact) — or the callback arrives with no dispatch metadata → rejected → re-dispatch. Expected, bounded, already the normal restart behavior.

### B. Redis node loss (machine dies)

- No replica/Sentinel → all runtime keys unavailable until the node is back; Redis is a **single point of availability** for the whole generation pipeline (backend loop skips ticks on ping failure; hub queues/running unreachable; callbacks can't be processed).
- If the disk survives: same as scenario A after restart. If the disk is lost: scenario C.
- Workers keep beaconing to the hub; hub keeps returning errors until Redis returns; workers idle-wait.

### C. Redis data loss (starts empty) — the main scenario

Traced end-to-end in §4. **Headline:** completed books keep working (player reads FS; C0 restores chunk flags + READY states), but **in-flight generation pauses and does NOT auto-resume** — nothing at startup rebuilds the scheduler's work list from PostgreSQL.

### D. Redis ↔ PostgreSQL divergence

- **Redis says READY, PG says stale (PG version newer):** scheduler pre-pass `detectVersionStale` (`runtime-scheduler.js`) reads PG `scenes.content_version`/`audio_config_version` vs `scene_assets.scene_*_version`; if a `ready` asset is behind → `markVersionStaleDirty` resets it to DIRTY → re-dispatch. **PG wins on staleness** — this is the designed priority.
- **PG says ready, Redis says generating/pending:** scheduler waits (GENERATING is not dispatchable); if the lease expired, reconcile `RELEASE_STALE_LEASE` → `markDirtyScene` → re-dispatch. Converges.
- **Orch invariant violations** (`audio_orch_invariant_*`, `video_orch_invariant_*`): reported in Phase D, auto-fixed via facade paths.
- **Verdict:** divergence is *healed*, not prevented; heal time is bounded by the next scheduler tick (5 s) or reconcile cycle (60 s).

---

## 4. Cold Redis — exact recovery path (code-traced)

```
Redis data lost
  ↓
backend startup (backend.cjs):
  • runtime.loop.start(redis)                     → fast tick every 5s
  • reconcileCycle(redis, deps, { startup: true })  → setImmediate after listen
```

### 4.1 What each startup phase actually does (empty Redis)

| Phase | File / function | Data source | What it writes back | Rebuilds active-scenes? |
|---|---|---|---|---|
| A result/error mailboxes | `reconciliation-engine.recoverResultKeys` | SCAN `animastor:result:*` / `error:*` | — (empty Redis ⇒ nothing) | no |
| B1/B2 stalled watchdogs | `checkStalledAudioScenes`/`checkStalledVideoScenes` | SCAN `audio-orch:*` / `video-orch:*` | — (empty) | no |
| C0 chunk recovery | `recoverAllBooksFromDisk` (`redis-helpers.cjs`) | **Filesystem** (`OUTPUT_DIR/{build}` — files ending `.mp3` with `_ch…_sc…`) | `animastor:asset-state:*` → **all three (audio, image, video) READY unconditionally** for every scene with a merged `.mp3` — even audio-only scenes get image/video=READY (P1); `chunk:*` flags are accurate (audio=ready, image=has IU pngs, video=has mp4); `chunks:{book}` set; `book-scenes:{book}:total/next-index` | **no** |
| C1/C1b orch states | `recoverAudioOrchStates`/`recoverVideoOrchStates` | SCAN `audio-orch:*` / `video-orch:*` | — (empty) | no |
| C2 version staleness | `checkVersionStaleness` | **PostgreSQL** `scenes` (WHERE content_version>1 OR audio_config_version>1) LEFT JOIN `scene_assets` | `orchestrator.markDirtyScene` → per-asset DIRTY + `scene_assets.status=stale` | **no** |
| C4 missing counters | `reconcileMissingSceneState` | **PostgreSQL** `SELECT DISTINCT book_id FROM scenes` | **log-only** (`[COUNTER-LOG-ONLY]`) | no |
| D full reconcile | `reconcileAll` | SCAN `animastor:event-journal:*` | the journal *is* the scene list — empty Redis ⇒ **zero scenes scanned**, the whole phase is a no-op | no |
| standalone | `backend.cjs` | Redis | reset `runtime:active-*` to 0; delete all `dispatch-lease:*`; counter reconciliation | no |

**No startup phase rebuilds the work list for ordinary (whole-book/scope) generation.** One partial exception verified in Recon #3: Phase C5 calls `resumeIncompleteSessions` (`startup-resume.js`), which resumes VBook/agent sessions (`book_generation_sessions` with `pending/generating/queued`) via `runBackgroundWindowGeneration` → `addActiveScene` (`window-generator.cjs:106`) — but only for *newly created* scenes of VBook sessions, not for existing incomplete scenes of ordinary regeneration. See `recoverable-work-set.md` §7a.

### 4.2 The result

- `animastor:active-scenes` = ∅ → `runtime-scheduler.tick` iterates zero scenes → **scheduler is idle**.
- Scenes that were mid-generation (no merged `.mp3` yet) are **not** restored at all: no asset state, no chunks, no work-list entry.
- Scenes that finished audio got **over-marked READY for image AND video** (C0 quirk — `recoverChunksFromDisk` sets all three asset states READY even when only audio exists; the chunk flags are the accurate ones).
- Completed books **play** correctly (player = FS + restored chunk flags + asset states).

### 4.3 How generation actually resumes (all client-triggered)

| Path | Trigger | Mechanism | Evidence |
|---|---|---|---|
| `POST /api/v1/generate` (open-book/generate flow) | client opens a book / legacy generate | if no chunks in Redis → `recoverChunksFromDisk`; for scenes still missing → `scene-window.slideWindow` / `initSceneWindow` → `startScene` → `addSceneToActiveIndex` + `orchestrator.setScenePending` | `routes/generation-routes.cjs` (recover + slide), `scene-window.js:733`, `scene-orchestrator.js:37` |
| `POST /book/:id/regenerate` | user presses Generate | `orchestrator.resetScenes` → `bookDiff.markDirtyScenes` → **`activeScenes.addActiveScene` per dirty scene** | `orchestrator.js:634`, `book-diff.cjs:453` |
| Manual/debug endpoints | operator | `debug-routes.cjs:367/425`, `recovery-routes.cjs` | — |

So the honest answer to the DoD question is:

> After total Redis loss, Animastor **preserves all finished work**, but **pauses generation**. The scheduler has nothing to do because the work list is only ever re-populated by a client action (open book + Generate, or regenerate). Reconciliation rebuilds flags and dirty markers, **not the work list**.

**The "unknown place" the task asked to find is precisely here:** the missing link is *"startup rebuilds active-scenes from PostgreSQL"* — it does not exist today.

---

## 5. `animastor:active-scenes` — complete writer/reader map

**Format:** `{bookId}:{chapterId}:{sceneId}` in a Redis SET. Single command API: `active-scenes-index.js` (T8), exported through `runtime-scheduler.addSceneToActiveIndex`.

| Kind | Call site | When |
|---|---|---|
| Writer | `scene-orchestrator.js:37` (`startScene`) | scheduler dispatches a NEW scene |
| Writer | `scene-window.js:733` (`startScene`) | window init/slide starts a scene |
| Writer | `book-diff.cjs:453` (`markDirtyScenes`) | edit/regenerate marks dirty scenes |
| Writer | `orchestrator.js:634` (`resetScenes`) | regenerate re-adds scenes |
| Writer | `reconciliation-engine.js:996/1027/1042/1067` (applyFix) | auto-fixes (MOVE_TO_PENDING, RELEASE_STALE_LEASE, REGENERATE_MISSING_ASSET, PROGRESS_TO_*) |
| Writer | `routes/generation-routes.cjs:199/227` (chunk-status auto-redispatch), `debug-routes.cjs:367/425` | manual / chunk self-heal |
| Writer | `window-generator.cjs:106` | background window generation |
| Reader | `runtime-scheduler.tick` (`getActiveSceneKeys`) | **the only production reader that drives dispatch** |
| Reader | `runtime-metrics`, `prometheus`, `progress-panel`, debug routes | observability |
| Remover | callbacks (`handleVideoCompleted` → `removeSceneFromActiveIndex`), scheduler (`allDone`), cancel routes, `book-diff` (reset), `cleanBookRedisKeys` | completion / cancel / delete |
| Rebuilder | **none at startup** (the gap); rebuild only via §4.3 client paths | — |

### Can active-scenes be fully rebuilt from PostgreSQL?

**Yes, in principle — and nothing does it today.**

Required data (all present):
- **Which scenes exist per book:** `scenes` table (`book_id, chapter_id, scene_id`) or, more accurately, book JSON on FS (`book.collectScenes`) — the FS book is the canonical scene list; `scenes` rows are lazily created (`ensureSceneRow`).
- **Which scenes still need work:** `scenes.is_dirty = TRUE` OR `scene_assets.status IN ('stale','pending','failed')` OR `scene_assets.scene_*_version < scenes.*_version` OR `scene_assets` row missing for an enabled layer. (Note: `getDirtyScenesByVersion` in `scene-assets-repo.js` already implements this predicate — but has **no production caller** today.)
- **What to skip:** scenes whose artifacts exist on FS with current versions (`scene_assets.status='ready'` + FS probe, like `recoverChunksFromDisk` does).

Algorithm (conceptual): for each book in PG/FS → collect scenes → skip READY/current-version ones → `addSceneToActiveIndex` for the rest → scheduler resumes. **Nothing implements this.**

**What is lost forever and PG can't restore:** in-flight dispatch identity (which stage was generating, which dispatch token), chunk-by-chunk IU progress, audio/video orch phase + group composition, lease ownership, worker assignment. **None of these need restoring** — re-dispatch is safe (deterministic filenames, fresh dispatch token → fresh hub dedup key, transition validation guards stale states). The only thing that must survive is the *set of scenes that need work*, and that is derivable from PG+FS.

---

## 6. State recoverability (per runtime state)

| State | Redis | PG | Filesystem | Recoverable after cold Redis? | Mechanism |
|---|---|---|---|---|---|
| Asset lifecycle (audio/image/video) | `asset-state:*` | `scene_assets` + versions | artifacts | **Partially** — finished audio-scenes get all-READY (over-marked); mid-generation scenes lost | C0 (over-approximate), C2 (DIRTY), client re-dispatch |
| active-scenes (work list) | `active-scenes` | `scenes` + `is_dirty` + `scene_assets` | book JSON | **Only via client action** — no startup rebuild | §4.3 paths |
| Leases | `dispatch-lease:*` | — | — | No — **and doesn't need to be** (deleted on startup; re-dispatch safe) | startup cleanup |
| Dispatch identity/meta | `dispatch-meta:*` | — | — | No (callbacks rejected; re-dispatched) | `verifyDispatchIdentity` |
| Quota counters | `runtime:active-*` | — | — | No — reset to 0 on startup | `backend.cjs` |
| Retry budgets | `runtime:retry:*` | — | — | No — fresh budgets | default |
| Audio-orch phase | `audio-orch:*` | — | audio chunks | Partially — executor `no_state` → `initPlaceholderReady`; chunks on disk trigger merge (`completeChunk` recovery) | executor + C1 |
| Video-orch phase + groups | `video-orch:*` | — | group mp4s | Partially — fresh `initState`; group files validated as cache-hit | executor + C1b |
| Chunk flags | `chunk:*` | — | files | **Yes** — rebuilt from FS (only scenes with merged `.mp3`; partial-chunk scenes skipped) | C0 `recoverChunksFromDisk` |
| Window progress | `book-scenes:*` | `book_generation_sessions` | book JSON | Partially — C0 sets total/next; sessions resumed from PG (`resumeIncompleteSessions`, Phase C5) | C0 + C5 |
| IU progress | `iu-progress:*` | `image_units` | pngs | Partially — re-derived on next dispatch; counter re-set from FS in `handleImageCompleted` | task-handler |
| Event journal | `event-journal:*` | `book_events` | — | No (Redis journal lost; PG journal survives) | — |
| GPU queues/running | hub `queue:*`, `running`, `processing` | — | — | No — jobs in flight are **lost at hub level** (result returns 409) and re-generated | hub + re-dispatch |
| Worker registry/heartbeats | `gpu-hub:workers`, `worker:heartbeat:*` | — | — | **Yes, self-heals** — workers re-beacon every 10 s → re-register | hub `/beacon` |
| Result/error mailboxes | `result:*`, `error:*` | — | — | No (lost with Redis; nothing to replay) | — |

**States that exist only in Redis** (task §6 focus): leases, dispatch identity, quota counters, retry budgets, orch phases, window counters, IU in-flight markers, hub queues/running, worker registry. All except the **work list** are safely re-derivable or don't need restoring.

---

## 7. Crash windows (partial orderings)

| Ordering | Remaining state | Scheduler sees after restart | Reconcile sees | Duplicate gen? | Permanent stall? | Artifact lost/overwritten? |
|---|---|---|---|---|---|---|
| PG updated → Redis updated → crash | both consistent | normal | normal | no | no | no |
| PG updated → (Redis update pending) → crash | PG newer | `detectVersionStale` → DIRTY | C2 → DIRTY | re-gen once (intended) | no | overwritten by new gen (intended) |
| Redis updated → (PG pending) → crash | Redis newer / PG older | READY honored (versions gate re-checks PG at completion) | C2 only if PG versions differ | possible duplicate | no | no |
| GPU job dispatched → Redis updated → crash | job in flight, lease lost | scene in active list → **re-dispatch** | stale-lease cleanup | **yes — duplicate generation of the same scene** | no | old result overwritten by new (same filename) |
| Artifact written → state not finalized → crash | file on disk, no READY | scene still PENDING/GENERATING → re-dispatch | C0 marks READY (if merged audio) | possible | possible — permanent stall only if the scene is missing from the work list AND no client action re-triggers it (§4.3) | overwritten by new gen |
| Backend crashes mid-callback (after hub forwarded) | result mailbox holds result | — | Phase A replays → `handleTaskResult` (dedup/identity) | guarded by `result-processed`/identity | no | no |

**Notes:**
- **Duplicate generation** after crash is possible and *bounded*: identical scene produces identical filenames; both jobs write to the same path, so whichever completion lands last overwrites the artifact; hub dedup key is dispatch-scoped so a fresh dispatch re-enqueues. Wasted GPU time, no corruption.
- **Permanent stall** after cold Redis: the one real case — scene needs work but is not in `active-scenes` and no client triggers it (§4).
- Partial chunk sets (some mp3 chunks, no merge) are re-covered by `completeChunk`'s FS probe (`expected_count` rebuilt from disk) once re-dispatched.

---

## 8. Idempotency of recovery

| Concern | Mechanism | Verified in |
|---|---|---|
| Reconcile runs twice (overlap) | distributed `animastor:cleanup-lock` (NX EX 120 s) + in-process `reconcileInProgress` flag | `reconcileCycle` |
| Startup recovery races the running scheduler | on cold Redis the active index is empty → scheduler no-ops; in normal ops both can touch one scene, but only one dispatch can hold the lease and transitions are validated | `dispatch-engine` lease + `validateAssetTransition` |
| Double finalization of a dispatch | atomic Lua claim (`CLAIM_FINALIZATION_SCRIPT`) + `dispatch-completed:{dispatchId}` marker | `finalizeDispatch` |
| Replaying the same result twice | `animastor:result-processed:{dispatch_id}:{job_id}:{build}` NX (1 h); `verifyDispatchIdentity` | `routes/generation-routes.cjs` + `task-handler` |
| Double re-dirty | `markDirtyScene` is idempotent (HSET same value), transition validation tolerates same-state | `orchestrator.js` |
| Hub enqueue duplicates | `animastor:job:{dispatch_id}:{job_id}` NX | `gpu-hub.js` |

**Conclusion:** the recovery machinery is idempotent; its weakness is not duplicate safety but **coverage** (it doesn't rebuild the work list).

---

## 9. Workers after Redis loss

- **Alive worker, backend thinks absent:** self-heals in ≤ ~10 s (beacon interval) — hub re-registers the worker and refreshes heartbeats; worker toggles recover.
- **Worker executing a job → Redis lost → backend restarts → scheduler re-dispatches:** this scenario is **real**. Sequence: worker finishes → `POST /task/result` → hub reads `animastor:running` → not found → **409 `stale_or_unknown_dispatch`** → worker retries, still 409, drops the result. Meanwhile the scene is re-dispatched (if it's back in the work list) with a fresh token → **duplicate generation**, old artifact overwritten. No corruption; wasted GPU work.
- **Late callbacks:** rejected by `verifyDispatchIdentity` (no dispatch metadata); terminally rejected results are dropped from the mailbox (no infinite replay).

---

## 10. Audio / video orchestration after Redis loss

- **audio-orch:** state gone → next dispatch's executor hits `no_state` → `initPlaceholderReady` + `setGenerating` (recovery path already built into `executeAudioDispatch`); chunks already on disk are found by `completeChunk`'s FS probe (`expected_count` rebuilt, empty chunks deleted, merge driven to completion). Merge state (WAITING_CHUNKS/MERGING) is lost but re-derivable from disk.
- **video-orch:** state + group composition gone → fresh `initState` on next dispatch; existing group files are re-validated by `isGroupFileValid` and treated as cache-hits only if unit_ids composition matches (it won't — composition was in the lost state) → **groups are re-generated even if present on disk**. Minor waste, correct outcome.
- Both recover **only when the scene is back in the work list** (§4.3).

---

## 11. The real last line of defense

```
cold Redis
  → PG (versions, is_dirty, scene_assets)     ← persistent anchor, always intact
  → FS (artifacts)                            ← persistent anchor, always intact
  → reconcile C0                              ← restores chunk flags + READY states (over-approximated)
  → reconcile C2                              ← re-dirties version-stale scenes
  → client action (open book + Generate)      ← REBUILDS THE WORK LIST (the actual recovery step)
  → scheduler + dispatch + orch state machines
```

**PostgreSQL is the anchor, the filesystem is the source of artifacts, reconciliation is the repairer of flags — but the client-triggered generate/regenerate flow is what actually restarts generation.** There is no automatic component today that re-creates the work list.

---

## 12. Redis HA assessment

| Option | Protects | Does NOT protect | Complexity | New failure modes | Operational cost | Needed for Animastor? |
|---|---|---|---|---|---|---|
| **A. Current + reconciliation** | Restart with intact volume | Full data loss ⇒ generation pauses until client action | 0 | — | 0 | works, but leaves the gap |
| **B. Redis persistence (AOF, appendfsync everysec)** | Restart data loss (~60 s window → ~1 s) | Node loss, disk loss, and **does not rebuild the work list if data was already lost** | Very low (2 lines in compose) | fsync-related stalls (negligible at this scale) | ~0 | **Yes — cheap first step** |
| **C. Redis replica / Sentinel** | Node loss (failover in ~seconds) | Data loss that happened *before* failover; doesn't rebuild the work list | Medium (sentinel trio or replica + promote) | split-brain, stale replica serving reads, promotion automation | Low-Medium (one more container + monitoring) | **Probably not yet** — Animastor tolerates minutes of pause; the real risk is permanent work-list loss, which Sentinel doesn't fix |
| **D. Redis Cluster** | Sharding + node loss | Same as C; overkill for a single small instance | High | slot migrations, client reconfig | High | **No** |
| **E. PG/FS-based work-list rebuild** (option from §5) | The actual gap: any Redis loss → generation resumes automatically | Nothing (pure gain) | Low-Medium (one startup phase; `getDirtyScenesByVersion` already exists) | re-dispatch of already-finished scenes if predicate is wrong (mitigated by FS probe) | ~0 | **Yes — this is the correct primary fix** |

**Answer to "does Animastor need a second Redis?":** **Not as the first priority.** The property Animastor actually needs is *"after Redis loss, generation must resume"*. That property is **not** delivered by HA — a replica still won't contain a work list that was lost, and an idle scheduler doesn't care whether Redis is single or sentineled. The cheapest correct fix is **AOF + a startup rebuild of active-scenes from PostgreSQL/filesystem** (option E). Sentinel only becomes interesting if node-loss RTO (minutes of no generation, no player progress streaming) becomes unacceptable.

---

## 13. Critical findings (summary)

1. **P0 (the gap):** nothing at startup rebuilds `animastor:active-scenes` from PG. Total Redis loss ⇒ generation pauses until a user opens the book and triggers generate/regenerate. `reconciliation-engine` rebuilds flags, not the work list (phases C0/C2 verified).
2. **P1 (quirk):** C0 (`recoverChunksFromDisk`) sets **all three** asset states to READY for any scene with a merged `.mp3`, even when image/video artifacts are missing. Playback is fine (chunk flags are accurate), but the "source of truth" overstates readiness → e.g. video may never be regenerated until a manual re-dirty.
3. **P2 (waste):** in-flight GPU results are dropped at hub level after Redis loss (409 `stale_or_unknown_dispatch`) → duplicate generation of the same scene (both jobs write to the same deterministic filenames — whichever completion lands last overwrites the artifact). No corruption.
4. **P3 (low):** Redis runs without AOF — restart window of up to 60 s (or much more with sparse writes) of runtime-state loss. Cheap to fix.
5. **P4 (reassuring):** no permanent data loss is possible for finished artifacts: PG + FS survive; `scene_assets` and versions are the durable mirror; the player never depends on Redis for serving media.
6. **P5 (nice-to-have):** `getDirtyScenesByVersion` — the "primary dirty detection mechanism, independent of Redis" — has **no production callers**. The predicate that would power the work-list rebuild already exists but is unwired.

---

## 14. Recommendations (no implementation)

1. **Enable AOF** (`--appendonly yes --appendfsync everysec`) in `docker-compose.yml` — closes the restart-loss window.
2. **Add a startup phase that rebuilds `active-scenes` from PG + FS** (option E): collect scenes per book from FS/PG, skip scenes whose `scene_assets` are `ready` and version-current and whose artifacts exist on disk, `addSceneToActiveIndex` the rest. Reuse `getDirtyScenesByVersion` semantics. Guard with the existing `CLEANUP_LOCK` so it can't race another cycle. *(This is the only recommendation that changes runtime behavior — it must be designed and approved as a separate Cathedral operation, not shipped as part of this audit.)*
3. **Fix C2 to also re-add marked scenes to the work list** (one line today: `markDirtyScene` doesn't touch the index; `resetScenes` does — align them).
4. **Revisit the C0 all-READY over-marking** when touching recovery: set image/video from FS probes (chunk flags already carry the truth).
5. **Do NOT deploy Sentinel/Cluster now.** Re-evaluate only if node-loss downtime or availability requirements change.
6. Keep reconciliation idempotency guarantees (they are sufficient); don't add new recovery that bypasses the facade.

---

## 15. Definition of Done — the answer

> **If Redis completely disappears tomorrow:**
> - Finished books keep playing (filesystem + PG; C0 restores chunk flags and READY states).
> - The backend restarts and runs its startup reconcile: C0 rebuilds chunk flags from disk, C2 re-dirties version-stale scenes in Redis, C4 logs missing counters, phase D finds nothing (journal is gone).
> - **The scheduler stays idle — `animastor:active-scenes` is empty and nothing at startup repopulates it (the identified gap).**
> - In-flight GPU results are dropped at the hub (409), workers re-register in ~10 s, late callbacks are rejected.
> - Generation resumes **only when a user opens the book and triggers Generate/regenerate** (which rebuilds the work list via `book-diff.markDirtyScenes` / `scene-window.startScene`); those scenes are regenerated from scratch (chunk/group states were lost), overwriting any partial artifacts — no data corruption, some wasted GPU work.
> - **Verdict: Redis is disposable for finished data, but NOT for the generation work list.** The system tolerates the loss with a pause + manual resume. Making it fully self-healing is a small, well-understood change (AOF + work-list rebuild) — not a second Redis.
