# Animastor — WORK_TO_DO / Active-Scenes Rebuild: Design Proof (Recon #4)

> **Cathedral Project — Recon #4 · Architectural proof before building Option E**
> Date: August 2026 · Method: code-first proof of the rebuild mechanism. **No production code changed.**
> Context: Recon #3 proved `WORK_TO_DO` is deterministically computable from PG + FS with empty Redis (constraints 1/2/4 hold, 3 solved by Operation #1 tombstones). This document proves the **mechanism** that would feed `WORK_TO_DO` into the scheduler — the last step before "build it".
>
> The dangerous property under study: this mechanism, unlike every previous operation, **itself starts generation work**. An error here produces not "book stays paused" but *duplicate generation / wrong-layer generation / resurrection of stale work / generation of disabled layers / generation from the wrong build*.
>
> Companion: `recoverable-work-set.md` (Recon #3 — the predicate), `redis-failure-model.md` (Recon #2 — gap analysis).

---

## 0. Verdict in one sentence

> The rebuild is architecturally sound **only if it restores per-asset Redis states from the PG+FS predicate before SADD-ing scenes into the active index**. "Writing only SADD" — the phrase from Recon #3 §6 that looked like a clean boundary — is **NOT sufficient**, because the scheduler decides *what to dispatch* from Redis per-asset states (`shouldScheduleAssets`), and an empty state key reads as `NEW`, which the scheduler treats as "dispatch everything". The boundary that IS provable: **reconciliation owns the work-list + runtime states; the scheduler owns execution (dispatch)**, and the two are serialized by distinct locks (`CLEANUP_LOCK` vs `SCHEDULER_TICK_LOCK`) plus idempotent membership (SADD) and lease-based single-flight dispatch.

---

## 1. The exact predicate (repeated from Recon #3, now with the exact code)

For one scene with enabled layers `L ⊆ {audio, image, video}` (layer caveat in §5), each stage `s ∈ L` needs work iff:

```
needs_work(s) = NOT has_valid_artifact(s)
              OR is_version_stale(s)
              OR has_pending_dirty_marker(s)
```

| Term | Exact implementation | File |
|---|---|---|
| `is_version_stale` ∪ `has_pending_dirty_marker` | **`getDirtyScenesByVersion(bookId)`** — one SQL: `scenes.is_dirty = TRUE OR (scene_assets.status='ready' AND (scene_content_version < content_version OR scene_audio_config_version < audio_config_version))` | `storage/postgres/repositories/scene-assets-repo.js:417-457` |
| `has_pending_dirty_marker` (extra) | `scenes.dirty_unit_ids` non-empty (`getDirtyUnitIds`); `scene_assets.status IN ('stale','failed','pending')` | `scene-assets-repo.js` |
| `has_valid_artifact` | **PG `ready` is NOT enough** — requires FS probe: `getSceneFilesStatus(buildDir, bookId, chapterId, sceneId)` (audio `.mp3` exists, image `*_iu*.png` exists, video `.mp4` exists) + `placeholderAudio.hasRealAudio` (a `.mp3` can be a TTS-placeholder and must not count as valid) | `scene-window.js` (`getSceneFilesStatus`, `checkSceneContentCache`), `placeholder-audio.js` |
| layer caveat | `layer-config` is **Redis-only**; predicate defaults to all-enabled (may regenerate disabled layers) — decision documented in §5.4 of `recoverable-work-set.md` | `services/layer-config.js` |

**All three inputs survive Redis loss** (PG rows + book JSON on FS + artifacts on FS). The predicate is read-only on PG/FS.

---

## 2. Proof that the predicate does NOT trust Redis asset state — and why that is necessary

### 2a. The danger it protects against (already true today)

`recoverChunksFromDisk` (C0, `redis-helpers.cjs:179`) restores per-asset Redis states to **READY/READY/READY for every scene with a merged `.mp3`** — without checking that `_iu*.png` or `.mp4` files exist:

```js
await state.unsafeRestoreAssetStates(redis, bookId, chapterId, sceneId, {
    audio: state.AssetState.READY,
    image: state.AssetState.READY,
    video: state.AssetState.READY
});
```

This is the **C0 over-marking quirk (Recon #2 P1)**: image/video marked READY with no files on disk. If the rebuild *trusted* Redis asset states, it would conclude "scene is ready" and skip it — permanently losing image/video work after every Redis restart.

### 2b. Proof the predicate ignores Redis

`getDirtyScenesByVersion` is a pure PG query. `getSceneFilesStatus` is a pure FS probe. Neither reads `animastor:asset-state:*`. The predicate's inputs are, by construction, the same whether Redis is empty or full. **Proof by construction: the function signatures take `(bookId)` / `(buildDir, bookId, chapterId, sceneId)` — no `redis` parameter.**

---

## 3. The scheduler's actual decision input — Redis per-asset states

This is the **key correction to the Recon #3 sketch**:

```js
// runtime-scheduler.js → attemptDispatch → shouldScheduleAssets
const assetStates = await state.getAssetStates(redis, bookId, chapterId, sceneId);
```

`state.getAssetStates` on a **missing key returns `{ audio: 'new', image: 'new', video: 'new' }`** (`state/scene-state.js` — "No fallback"). And `shouldScheduleAssets` treats `NEW` as "dispatch":

```js
if (audioEnabled && assetStates.audio !== READY && !== FAILED && !== GENERATING && !== PLACEHOLDER)
    stages.push('audio');
```

**Consequence:** if the rebuild only SADD's a scene with an empty asset-state hash, the scheduler will dispatch **all enabled layers** — including layers with valid artifacts on disk (duplicate generation, constraint (1) violation) and layers the user disabled (constraint (4) violation, since layer-config is also Redis-only).

**Therefore the rebuild MUST materialize per-asset Redis states from the predicate before SADD:**
- layer with valid artifact at current version → `READY`
- layer needing work → `PENDING` (or `DIRTY` via `orchestrator.markDirtyScene`, which also writes PG `stale` — see §4)
- disabled layer → state not written, and layer-config must be re-seeded (or the scheduler's `getLayerConfig` default all-enabled will dispatch it anyway — **open decision §10.1**)

The `attemptDispatch` version-stale pre-pass (`detectVersionStale` → `markVersionStaleDirty`, runtime-scheduler.js) partially covers this for `ready` PG rows, but it reads PG per-scene lazily *after* dispatch planning and does not rescue image/video over-marked by C0.

---

## 4. State writes must go through the facade (single-owner rule)

The project's own rule (S2.4, `scene-state.js` header): lifecycle transitions MUST go through `orchestrator.js`; `unsafeRestoreAssetState(s)` is whitelisted **only for restore/startup-recovery paths** — which is exactly what the rebuild is. Two legitimate options:

| Write | Via | Effect |
|---|---|---|
| `orchestrator.setScenePending(redis, bookId, ch, sc, 'image')` | facade (journaled, transition-validated) | Redis state `image: pending`; no PG write |
| `state.unsafeRestoreAssetStates(...)` | S2.4-whitelisted restore path (same as C0) | Redis states only; already used by startup recovery |
| `orchestrator.markDirtyScene(redis, ..., ['audio'])` | facade | Redis `dirty` + **PG `scene_assets.status='stale'`** (double-write, heavier) |

For a pure runtime rebuild, `setScenePending` per needed layer (or one `unsafeRestoreAssetStates` batch per scene) is the minimal correct write. `markDirtyScene` is the right tool when PG also needs to be made consistent (e.g. a scene stuck `ready` in PG that the predicate found stale — `detectVersionStale` already covers this per-tick).

---

## 5. build_id pinning — proven single source

Scheduler's `attemptDispatch` resolves the build it dispatches into:

```js
const buildId = loadedBook?.manifest?.build_id || null;   // runtime-scheduler.js
```

`loadedBook` comes from `book.loadBook(bookId)` (the **book JSON on disk**) — which survives Redis loss. `scene_assets` rows carry `build_id`, and artifacts live under `OUTPUT_DIR/{build_id}`.

**Proof of consistency:** the predicate probes `OUTPUT_DIR/{build_id}` where `build_id = book.loadBook(bookId).manifest.build_id` — the **same expression the scheduler uses**. PG `scene_assets.build_id` must be cross-checked against the manifest (a scene row may reference an older build after a re-import); the manifest is the pinned source, matching `attemptDispatch`.

**Edge:** books without `manifest.build_id` (legacy parse.js format) — `attemptDispatch` passes `loadedBook?.manifest?.build_id || null` down to the executor (runtime-scheduler.js). The `'default'` substitution happens deeper in the executor/orchestrator path (same convention as `recoverChunksFromDisk`'s `buildId || 'default'`). **The predicate must mirror the exact same expression** (`build_id = manifest?.build_id || 'default'`) — verify against the executor's fallback at implementation time, or it will probe the wrong directory.

---

## 6. CLEANUP_LOCK — how the rebuild is serialized against everything else

### 6a. The lock today

`reconcileCycle` (reconciliation-engine.js) wraps the entire recovery pipeline in one distributed lock:

```js
const lockKey = config.REDIS.CLEANUP_LOCK || 'animastor:cleanup-lock';
const lockAcquired = await redis.set(lockKey, lockToken, 'NX', 'EX', 120);
if (!lockAcquired) { /* skip cycle */ }
// ... all phases A/B/C/D ... finally { releaseLock(); }
```

**The rebuild must run as a startup phase inside `reconcileCycle` (alongside C0–C5), not as a separate scheduler**. This gives it, for free:
- Mutual exclusion against every other reconcile/cleanup phase (single instance writes recovery state).
- The existing `startup:true` gating (C phases only run on the first cycle after boot).
- Journaling of the cycle in `event-journal` (RECOVERY_STARTED/COMPLETED).

**⚠️ Phase ordering is a hard constraint:** C0 (`recoverAllBooksFromDisk` → all-READY over-marking), C1/C1b (audio/video-orch recovery → FAILED/READY) and C2 (`checkVersionStaleness` → `markDirtyScene` → DIRTY + PG stale) **all write per-asset Redis states**. If the rebuild ran before them, they would clobber its predicate-derived states (C0's all-READY would overwrite the rebuild's correct PENDING/READY). **The rebuild must be the LAST state-writing C-phase** — ordered after C0, C1, C1b, C2 — so its derived states are the final word. (C5 session-resume SADDs new scenes and is idempotent on top; either order vs C5 is safe.)

### 6b. The scheduler is a *different* lock — and that's correct

The scheduler serializes its own ticks with `SCHEDULER_TICK_LOCK` (dispatch-engine.js, NX 30s), **not** `CLEANUP_LOCK`. So the rebuild (under CLEANUP_LOCK) can run concurrently with a scheduler tick. Why this is safe:

1. **Membership is idempotent:** `addActiveScene` = `SADD` — re-adding an already-present scene is a no-op; a tick reading the set mid-rebuild simply sees a subset, and the next tick sees the rest.
2. **Dispatch is single-flight per (scene,stage):** `dispatchStage` acquires `animastor:dispatch-lease:{book}:{ch}:{sc}:{stage}` with `NX EX` — if the rebuild's state write lands while a tick is mid-dispatch, the lease already prevents a second dispatch. If a client `/regenerate` raced the rebuild (regenerate sets states via the facade, rebuild via `unsafeRestoreAssetStates` — **note the unsafe write bypasses transition validation, S2 rule**), the rebuild's `PENDING` write could theoretically downgrade a facade-set `GENERATING`; the NX lease still gates dispatch (no duplicate), and the eventual callback/lease-expiry resolves the state. **Cleanest fix: have the rebuild write states via the facade (`setScenePending`) per §4/§10.2 — then transitions are validated and this caveat disappears.**
3. **Ordering inside the rebuild matters:** write states **first**, SADD **last** (a tick that observes the scene between the two writes sees correct states; a tick before the SADD sees nothing).
4. **Late callbacks are deduped** by `dispatch-scoped` markers (`animastor:job:{dispatch_id}:{job_id}` NX, `result-processed` NX, `verifyDispatchIdentity` in dispatch-engine.js) — a scene re-dispatched by the rebuild after a stale dispatch cannot double-apply a result.

**Residual race to document (not a defect):** an in-flight GPU job at the moment of Redis loss has no lease/metadata after restart → the rebuild re-dispatches it; the second job writes the same deterministic filename (overwrite). This is the *intended* bounded re-dispatch (Recon #2 §7/§9), not a violation of no-duplicates.

---

## 7. Proof: SADD is idempotent and cannot create duplicate work

| Layer | Mechanism | Proof |
|---|---|---|
| Membership | `redis.sadd(ACTIVE_SCENES_KEY, sceneKey)` — a set; re-adding same key is no-op (`added: added > 0`) | `active-scenes-index.js:addActiveScene`; `runtime-scheduler.addSceneToActiveIndex` delegates to it |
| Per-stage single-flight | `dispatchStage` → `acquireStageLease` → `redis.set(leaseKey, token, 'NX', 'EX', ttl)` — at most one live lease per (scene,stage) regardless of how many ticks/rebuilds see the scene | `dispatch-engine.js` |
| Callback dedup | `verifyDispatchIdentity` rejects callbacks whose `dispatch_id` doesn't match live metadata; `result-processed` NX marker per (dispatch, job, build) | `dispatch-engine.js` |
| Version gate on completion | `orchestrator.completeStage` fail-closed version check before `markReady` — a stale-completing dispatch finalizes DIRTY, never READY | `orchestration/orchestrator.js` |
| Work-set gating | the §1 predicate excludes scenes with valid artifacts; the rebuild must additionally exclude tombstoned books (`generationCancelRepo.getAllCancelled()`, Operation #1) | `generation-cancel-repo.js` |

**Conclusion:** even if two sources (rebuild + a client regenerate) add the same scene, the result is one dispatch per (scene,stage) at a time, one final artifact, and stale completions are demoted to DIRTY. SADD itself cannot create work — it only *admits* a scene to the set the scheduler walks; dispatch is gated downstream.

---

## 8. The responsibility boundary — proven

```
reconciliation (rebuild phase under CLEANUP_LOCK)
    │  computes WORK_TO_DO from PG + FS (predicate §1)      ← does NOT touch GPU
    │  materializes per-asset Redis states (§3)             ← runtime cache only
    │  SADD into animastor:active-scenes                    ← idempotent admission
    ▼
scheduler (tick under SCHEDULER_TICK_LOCK)
    │  walks active-scenes                                  ← sole owner of progression
    │  shouldScheduleAssets (reads Redis states)            ← decision input
    │  dispatchStage → GPU hub                              ← the ONLY thing that starts work
```

- **The rebuild never dispatches.** Its only writes: Redis per-asset states + SADD. This is provable by construction if the phase calls only `setScenePending`/`unsafeRestoreAssetStates` + `addSceneToActiveIndex`.
- **The scheduler never rebuilds.** It consumes whatever is in the index and states.
- Both are idempotent at their boundaries (set-add, NX lease), so their interleaving is safe without a shared lock.

**This is the boundary the user asked to verify, and it holds — with the §3 amendment:** the boundary is "reconciliation restores the work index *and the runtime states it needs*; scheduler owns execution". The original "writing only SADD" formulation was incomplete because it omitted the state materialization that the scheduler's decision actually consumes.

---

## 9. Failure scenarios — what each one does under this design

| Scenario | Behavior | Verdict |
|---|---|---|
| Rebuild runs twice (two startups) | SADD no-op; state writes idempotent; second run recomputes the same predicate | ✅ safe |
| Rebuild races a scheduler tick | §6b: set-membership snapshot, NX lease, dispatch dedup | ✅ safe |
| Rebuild races a client `/regenerate` | Both SADD same scenes; regenerate's `resetScenes` already sets states; lease gates dispatch | ✅ safe (lease is the arbiter) |
| Scene valid on disk, Redis empty | Predicate: `has_valid_artifact` true → scene **excluded from WORK_TO_DO** → no state write, no SADD | ✅ no duplicate |
| Scene half-generated (audio done, image missing) | Predicate: audio valid → state `READY`; image needs work → `PENDING` + SADD | ✅ correct resume |
| C0 already over-marked a scene READY | Predicate ignores Redis → re-derives from PG+FS → rewrites correct states | ✅ self-heals C0 (P1) |
| Layer disabled in layer-config | layer-config lost with Redis → predicate default all-enabled → **may re-dispatch disabled layer** | ⚠️ **open decision** (§10) |
| Book cancelled (tombstone) | `getAllCancelled()` → book skipped entirely | ✅ (Operation #1) |

---

## 10. Open decisions before implementation

1. **Layer-config persistence** (carried from Recon #3 §5.3): re-seed `animastor:layer-config:{book}` from where after Redis loss? Options: (a) persist to book JSON on every PUT, (b) PG column, (c) accept regenerating disabled layers once per Redis loss. **Recommend (a)** — smallest change, book JSON already survives.
2. **PENDING vs DIRTY for the state write:** `setScenePending` (Redis-only) vs `markDirtyScene` (also writes PG `stale`). For a rebuild, Redis-only is sufficient and lighter; PG consistency for stale rows is already handled by `detectVersionStale` per tick. **Recommend PENDING.**
3. **Rebuild trigger:** only `startup:true` (first cycle) — never the periodic 60s cycle — to avoid surprise auto-resumption mid-session. Matches the recover-chunks "never auto-start without user action" policy, generalized.
4. **Scope resumption:** gen-scope is Redis-only; the rebuild resumes the whole book (not the last scope). Scenes outside the last scope that fail the predicate are genuinely incomplete → correct to resume. Document, don't gate.
5. **Startup cost:** the predicate is O(books × scenes) PG rows + one FS `readdir` per build dir at boot. For a large library, batch the `getDirtyScenesByVersion` calls per book and memoize `getSceneFilesStatus` per scene; the phase already runs only on `startup:true`, so worst case is one bounded scan per restart.

---

## 11. Definition of Done — the answers

> **1. Exact WORK_TO_DO predicate?** `getDirtyScenesByVersion` + `dirty_unit_ids`/non-ready `scene_assets` statuses + FS probe (`getSceneFilesStatus`) + `hasRealAudio`, per enabled layer (§1).
>
> **2. Does it trust Redis asset state?** **No** — proven by construction (§2): PG query + FS probe, no `redis` parameter. Necessary because C0 over-marks READY/READY/READY (§2a).
>
> **3. Is build_id correctly pinned?** **Yes** — manifest.build_id from book JSON, the same expression the scheduler uses in `attemptDispatch`, with a `'default'` fallback for legacy books to be mirrored exactly at implementation time (§5).
>
> **4. Does CLEANUP_LOCK exclude races?** **Yes for rebuild-vs-rebuild** (single NX lock around the whole cycle, §6a). Rebuild-vs-scheduler is safe by **idempotency + leases, not by a shared lock** (§6b): SADD no-op, NX dispatch lease, callback dedup, ordered writes. **Hard requirement: rebuild must be the last state-writing C-phase (§6a ordering constraint).**
>
> **5. Is SADD idempotent / no duplicate work?** **Yes** — set-add + per-stage NX lease + dispatch-scoped callback dedup + fail-closed version gate (§7). SADD admits; dispatch is gated downstream.
>
> **6. Is "reconciliation only restores the work index" a real boundary?** **Partially** — the index *and the runtime states the scheduler consumes* must be restored by reconciliation; the scheduler remains the sole owner of execution. "Only SADD" was under-specified (§0, §3, §8).

**Verdict: build is authorized after decision §10.1 (layer-config persistence).** The mechanism is provably idempotent and race-safe; the one correctness gap (disabled-layer regeneration after Redis loss) is a policy decision, not an architecture flaw, and is exactly the same gap already documented in Recon #3.
