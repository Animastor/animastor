# Audio Orchestration — Architectural Fixes Against "It Worked, So Leave It"

> **Date:** 2026-07-20
> **Context:** series of today's commits (`281d192`, `ebbcb4f`, `4a17f55`,
> `ecde189`, `1ce49ee`, `02e99a5`) patched audio orchestration ad-hoc — timeouts,
> skip-fail, hardcodes, and defensive guards. Below documents what the core design
> should be so these patches disappear as symptoms, not as_LONG-TERM solutions.
>
> **Style:** each section describes (a) the current hack, (b) why it exists,
> (c) what it should be architecturally, (d) migration steps.

---

## 1. Timeouts Should Not Be Manually Tuned

### Current Hack (`281d192`)
```js
// runtime-config.js
AUDIO_CHUNK_STALL_MS: 900000, // 15 min
LEASE_TTL_S.AUDIO:    20 * 60, // 20 min
// gpu-hub GPU_TIMEOUT: 10 min (env)
```
The commit message literally fixes the invariant "GPU_TIMEOUT < STALL < LEASE_TTL"
by tuning constants. Any change to `GPU_TIMEOUT` in env silently breaks orchestration.

### Why It Exists
The watchdog `checkStalledAudioScenes` doesn't know whether the worker is dead or
just taking a long time. So a "safe" upper bound is chosen that is always
larger than the GPU timeout.

### What It Should Be
**The source of truth should be the callback from the worker/hub, not a timer.**

- `gpu-hub` already handles `GPU_TIMEOUT` — it does NOT report "success", but
  sends an explicit `worker_dead` / `job_timeout` error.
- This error should reach backend as an asynchronous event (via callback
  endpoint or Redis pub/sub `animastor:gpu:events`), NOT silently waiting
  for `AUDIO_CHUNK_STALL_MS` to expire.
- The `checkStalledAudioScenes` watchdog remains **only as a failsafe** for
  the case "worker died and hub didn't report it" (e.g., network loss between
  hub and backend). Its timeout should be **multiplicatively larger** than any
  reasonable scenario, not tuned to millisecond precision:

```js
// Architectural invariant:
//   STALL_FAILSAFE_MS = max_gpu_timeout_ms * 3
// Derived from GPU_TIMEOUT, not an independent constant.
const GPU_TIMEOUT_MS = Number(process.env.GPU_TIMEOUT_MS ?? 600_000);
const STALL_FAILSAFE_MS = GPU_TIMEOUT_MS * 3;  // 30 min with 10-min GPU

// LEASE_TTL only insures against lost callbacks:
const LEASE_TTL_S = { AUDIO: Math.ceil(STALL_FAILSAFE_MS / 1000) + 60 };
```

- If hub sends explicit `job_timeout` — `failWaitingScene` is called immediately,
  without waiting for the watchdog.
- The config retains ONE input constant (`GPU_TIMEOUT_MS`), everything else is
  computed. No more "STALL = 15, LEASE = 20, GPU = 10" — formula instead of
  magic numbers.

### Migration
1. Introduce `GPU_TIMEOUT_MS` as single source of truth, derive `STALL` and
   `LEASE_TTL` from it.
2. Add handling in `task-handler.cjs` for `gpu_hub_error` event → direct
   call to `failWaitingScene(reason='gpu_timeout')`.
3. Rewrite test `runtime-timeouts.test.js` to verify the formula, not
   hardcoded values.

---

## 2. Zero-Byte Chunks — Retry, Not Skip

### Current Hack (`ebbcb4f`)
```js
const MIN_CHUNK_BYTES = 100;
if (size < MIN_CHUNK_BYTES) {
    fs.unlinkSync(chunkPath);            // silently delete
    await redis.del(`...:${chunkId}:audio`); // clear dedup
}
// these indices are simply absent from merge
```
TTS returned 0 bytes → file deleted → chunk treated as "missing" → wait for
re-dispatch. The symptom (empty TTS output) is masked instead of becoming a
diagnostic.

### Why It Exists
GPU hub sometimes returns 200 OK with empty body (edge-case model timeout).
Merge logic shouldn't fail on empty data — so they are "cut out."

### What It Should Be
**Empty TTS output is a recoverable error with an explicit retry contract, not
just-skip-it.**

- TTS provider returns explicit error instead of empty buffer. If the provider
  doesn't do this — `task-handler.cjs` validates the result and publishes a
  failure event with `reason='tts_empty_output'`, NOT writing a 0-byte file.
- Orchestrator maintains a **per-chunk retry budget** (see §4): e.g.,
  `max_attempts=2` per chunk. Empty output → retry. After budget exhausted →
  chunk marked `permanently_failed`, entire scene goes to `FAILED` with a clear
  reason (not silent absent in merge).
- `MIN_CHUNK_BYTES` remains only as **defense-in-depth** for the case where
  the file was written anyway (crash between write and validation). Nobody relies
  on it for normal flow.

### Migration
1. In `task-handler.cjs` add validation: `if (result.length < MIN) emit('chunk_failed', { chunkId, reason: 'empty' })`.
2. In `audio-orchestrator.js` introduce `retry_count` per chunk in state:
   ```js
   chunks: { 1: { attempts: 2, status: 'ok' }, 2: { attempts: 3, status: 'failed' } }
   ```
3. `completeChunk` doesn't check bytes for normal path, only for recovery path.

---

## 3. Stale Re-Dispatch — Explicit Leases, Not Phase Guards

### Current Hack (`4a17f55`)
```js
// executeAudioDispatch start:
if (phase === WAITING_CHUNKS || phase === MERGING) {
    return { completed: true }; // guard against re-dispatch
}
```
Guard added because scheduler could re-dispatch a scene whose chunks are
already in flight. This fixes the symptom (scheduler doesn't know scene is busy),
not the cause.

### Why It Exists
Between `executeAudioDispatch` and `setWaitingChunks` there's a window where the
scene state = `GENERATING`, but dispatch is already sent. Scheduler on next tick
sees "not DONE, not FAILED" → re-dispatches. New dispatchId makes all
old results `stale_dispatch`.

### What It Should Be
**Dispatch is a lease, not a phase.** A lease is an exclusive right to continue
work, with TTL and explicit owner.

- On entering `executeAudioDispatch`, the orchestrator acquires
  `dispatch-lease:{sceneId}` with TTL = `STALL_FAILSAFE_MS` and owner =
  `dispatchId`. If lease is occupied — exit with `completed: true` UNCONDITIONALLY.
- `setWaitingChunks`, `completeChunk`, etc. accept `dispatchId` and
  verify it matches the lease owner. Mismatch → silent drop
  (incoming result is not ours).
- Watchdog on stall': doesn't "reset phase" but **revokes the lease** (TTL expired
  → automatically free) then transitions state to PENDING for the scheduler.
- Phase guards (`WAITING_CHUNKS && return`) are removed — they're redundant with
  a lease.

```js
// Pseudocode:
async function executeAudioDispatch(redis, scene, dispatchId) {
    const lease = await acquireLease(redis, scene, dispatchId, TTL_MS);
    if (!lease.acquired) {
        log(`scene already under dispatch (owner=${lease.owner}) — skip`);
        return { completed: true };
    }
    // phase — ONLY between lease acquire and release;
    // if a second call with same dispatchId reaches here — lease is already ours,
    // but it's meaningless (idempotent by design).
    ...
}
```

### Migration
1. Introduce `acquireDispatchLease` / `releaseDispatchLease` in Redis (SETNX +
   TTL). This partially exists (`DISPATCH_LEASE_PREFIX`) but is used only for
   quotas — extend to exclusive scene ownership.
2. All chunk-result receivers (`completeChunk`, `task-handler`) must
   validate `dispatchId === lease.owner`, otherwise drop.
3. Remove phase-guard at start of `executeAudioDispatch`.
4. Signaling: if `completeChunk` receives mismatch, emit metric
   `audio.stale_result_dropped{reason=dispatch_id_mismatch}`.

---

## 4. "9+9 Duplicates" — Cache-Hit Per Chunk, Not Bulk-Delete

### Current Hack (`ecde189`)
Commit removed `bulk-delete` of chunks when `existingCount !== expectedCount`.
Previously `generateSceneAudio` wiped all chunks and re-dispatched everything.
This was a scorched-earth "start over" approach that destroyed partial progress.

### Why It Exists
Expected chunk count != disk cache size — no trust in cache. "Safe" approach is
to recalculate everything.

### What It Should Be
**Chunk is an atomic idempotent unit with persistent identity and own cache.**

- Each chunk has stable id `{sceneId, chunkIndex}` and content hash
  (from source text). Cache key = `{chunkId, contentHash}`.
- `sendPerSegmentAudio` already does per-chunk cache-hit (commit noted this).
  This is the correct behavior — all dispatch calls are idempotent per-chunk.
- `generateSceneAudio` should NOT know about chunk cache AT ALL. Its
  responsibility is "give me expected chunks"; presence/absence of each
  is resolved below.
- "Expected count mismatch" means project segmentation changed
  (e.g., scene text was edited). In this case, **chunk cache is invalidated by
  content hash**, not by wiping everything. Chunks whose content hash matches —
  remain; new/changed — re-sent.

```js
// Correct flow:
async function dispatchSceneChunks(scene, expectedChunks) {
    for (const chunk of expectedChunks) {
        const hash = contentHash(chunk.text);
        const cached = await cache.get(chunk.id, hash);
        if (cached) {
            markChunkReady(chunk.id, cached);
        } else {
            await cache.invalidate(chunk.id); // only this one
            await sendToGpu(chunk);
        }
    }
}
```

- Hardcoded "9+9" in commit message is just a symptom; architecturally,
  numbers should not appear anywhere.

### Migration
1. Introduce `chunk.content_hash` in `chunk-metadata` (Redis) at segmentation.
2. `findExistingSceneChunks` returns `[{ index, hash }]`, not `[index]`.
3. `sendPerSegmentAudio` compares hash; mismatch = invalidate + redispatch
   ONE chunk.

---

## 5. Batch Dispatch — Explicit Plan, Not "Narration First, Then Dialogue"

### Current Commit (`1ce49ee`)
```js
// Send Chung first narration pieces, then dialogue
```
Commit messages lack information. Semantic change of dispatcher for a specific
edge-case (probably latency prioritization or ordering for narration).

### Why It Exists
Dialogue chunks are apparently more expensive/slower, or they're deferred so
narration is ready sooner. But this is **prioritization policy**, buried in
dispatch order.

### What It Should Be
- Dispatch should accept a **plan** (`ordered list of chunk specs`), not a
  free list. Plan is formed in one place (segmentation layer), where
  knowledge about chunk types lives.
- Chunk type (`narration`/`dialogue`) is a plan attribute, not a dispatch concern.
- Prioritization (if needed) — separate strategy:
  ```js
  const ORDERING = { LOW_LATENCY_PREVIEW: 'narration-first', UNIFORM: 'round-robin' };
  dispatchSceneChunks(scene, { ordering: ORDERING.LOW_LATENCY_PREVIEW });
  ```
- Currently buried in `1ce49ee` without tests and without docs mention —
  any next semantic change will go through "fix and forget" again.

### Migration
1. Extract type parameter into `generateSceneAudio(scene, { ordering })` signature.
2. Document current policy and rationale in `ORCHESTRATION.md`.
3. Test ordering (reconstruct plan from dispatch journal).

---

## 6. Filesystem Order — Deterministic Naming, Not Sort-As-Patch

### Current Commit (`02e99a5`)
```js
// chunks.js
chunks.sort((a, b) => a - b);
```
Comment literally says: "CRITICAL: sort numerically — filesystem order
... is NOT deterministic." This is correct, but it's a post-hoc patch revealing
that **filenames were not a deterministic source of order**.

### Why It Exists
`readdirSync` on EXT4 returns hash-table order. If consumer
doesn't sort — it gets garbage. Before this, merge fed ffmpeg concat
chunks in arbitrary order — dialogues were lost, nobody understood why.

### What It Should Be
- **Chunk id encoding should be self-documenting and sort-stable**: the fact
  that `pad(4)` (`0001`, `0002`) sortable as string equals numeric sort is
  important and should be an invariant, not an accident.
- All chunk file consumers **must work with an ordered index list**, not with
  raw `readdirSync`. For example:
  ```js
  function listSceneChunksOrdered(sceneId, expectedCount) {
      // Not readdir — explicitly enumerate expected indices.
      return Array.from({ length: expectedCount }, (_, i) => i + 1)
          .filter(i => fs.existsSync(path(i)));
  }
  ```
  This eliminates the possibility of "readdir returned arbitrary order."
- Rename `findExistingSceneChunks` to `getExistingChunkIndices` and make it
  enumeration-based, not readdir-based.
- `.sort()` remains as cheap defense-in-depth, but carries no responsibility.

### Migration
1. Rewrite `chunks.js::findExistingSceneChunks` to enumeration (expected_count passed from orchestrator state, not from fs).
2. Audit all consumers of `findExistingSceneChunks` — should they know
   count? If yes — pass `expectedCount` to avoid Wild fs scans.
3. Test: create chunks 1, 9, 10 → merge should yield order [1, 9, 10],
   not [1, 10, 9].

---

## 7. General Principles Currently Missing

| Principle | Current State | Should Be |
|-----------|---------------|-----------|
| **Single source of truth for timeouts** | 3 independent constants | formula from `GPU_TIMEOUT_MS` |
| **Idempotent dispatch** | sheriff phase guards | lease per dispatchId + validate at every step |
| **Chunk as cache atom** | bulk-delete on mismatch | per-chunk content hash cache |
| **Recoverable vs permanent failure** | everything triaged after the fact | retry budget per chunk, explicit after-budget failure |
| **Dispatch plan** | hidden in code | explicit ordered plan + policy |
| **Deterministic data ops** | sort as patch | explicit enumeration, not readdir semantics |
| **Failure signalling** | `[DEBUG]` logs | structured events in journal + metrics |

---

## 8. Migration Priorities

1. **P0 (data loss risk):** §6 — enumeration instead of readdir. Cheap fix,
   eliminates an entire class of bugs.
2. **P0 (silent corruption):** §2 — empty TTS as retry-able failure, not skip.
   Currently empty chunks simply disappear.
3. **P1 (reliability):** §4 — per-chunk content hash cache. Eliminates duplicate
   dispatch as a class.
4. **P1 (operations):** §3 — lease instead of phase guards. This is a foundational
   item for all remaining orchestration.
5. **P2 (cleanup):** §1 — timeouts via formula. Works today, but will bite
   on first GPU_TIMEOUT change.
6. **P2 (documentation):** §5 — extract batch dispatch to explicit plan + doc.

---

## 9. Anti-Patterns to Avoid During Implementation

- **"Patch and forget"**: every section listed is today a
  symptom patch. Don't repeat this in migration: if introducing retry —
  introduce retry budget and metric, not "try once more."
- **State machine with implicit transitions**: `GENERATING → WAITING_CHUNKS`
  is done from three places (`executeAudioDispatch`, `completeChunk` race-condition
  branch, `failWaitingScene` recovery). Each implicit transition = future
  bug. Transitions should have one owner per phase.
- **DEBUG logs instead of structured events**: `[DEBUG]` strings are today
  the only way to understand what happened. This is a debugging tool, not
  observability. Events (`chunk_received`, `merge_started`, `lease_acquired`)
  should go to the journal.
- **"Heat" invariants in comments**: comments like "invariant: GPU <
  STALL < LEASE" are OK as documentation, but there should also be runtime
  assertions (following the pattern in `tests/runtime-timeouts.test.js`,
  extend to all invariants).

---

## TL;DR for Next Patch Authors

> If you're writing another audio orchestration fix right now — first check
> whether it relates to one of the seven points above. In 90% of cases "new bug"
> is the same symptom in a different wrapper, and it should be fixed at the
> architecture level, not with yet another `if (phase === ...)` at the top of a function.

---

## Implementation Status as of 2026-07-21

| § | Item | Status | Note |
|---|------|--------|------|
| 1 | Timeouts via formula | ✅ Implemented | `GPU_TIMEOUT_MS` → STALL *3 → LEASE +60s |
| 2 | Zero-byte chunks as retry | ❌ Skipped | Current watchdog works; explicit retry — over-engineering |
| 3 | Lease instead of phase guards | ✅ Implemented | Guard removed; A2 ensures LEASE > STALL |
| 4 | Per-chunk content hash | ❌ Skipped | "9+9" already fixed; file cache works |
| 5 | Explicit dispatch plan | ❌ Skipped | No second alternative — overengineering |
| 6 | Deterministic enumeration | ✅ Implemented | `expectedCount` → enumeration; readdir fallback |
| 7 | General principles | 🟡 Partial | SSOT (timeouts) + lease (dispatch) done. Rest — deferred |

**Details:** see `docs/02-orchestration/AUDIO_ORCH_ARCHITECTURAL_TODO.md`
