# Audio 8/9 Race Condition — Retry Timer vs GPU Hub

> **Date:** 2026-07-18  
> **Status:** Workaround replaced by orchestration  
> **Tags:** `audio`, `race-condition`, `retry`, `gpu-hub`, `completeChunk`

---

## 1. Symptom

When generating audio for a scene with 9 chunks, progress would reach 8/9 and then **restart from zero** — an infinite loop:

```
8/9 → retry → max retries → failStage → re-dispatch → 8/9 → ...
```

Visually in the UI: progress grows to 8/9, then resets and starts from 0.

---

## 2. Diagnostics

Debug logs were added with prefixes `[DEBUG-CHUNK]`, `[DEBUG-AUDIO]`, `[DEBUG-RESULT]`, `[DEBUG-DISPATCH]` in 4 files:

| Prefix | File | What it logs |
|---------|------|-------------|
| `[DEBUG-DISPATCH]` | `scene-orchestrator.js` | After `setWaitingChunks` and `generateSceneAudio` |
| `[DEBUG-AUDIO]` | `generation.js` | Segment count, types, and individual chunk dispatch |
| `[DEBUG-RESULT]` | `task-handler.cjs` | Each result arriving from GPU hub |
| `[DEBUG-CHUNK]` | `audio-orchestrator.js` | `completeChunk` calls, which chunks are on disk, retry attempts |

Logs showed:

```
[DEBUG-AUDIO] ✅ SENT chunk 0001 (1/9)
[DEBUG-AUDIO] ✅ SENT chunk 0002 (2/9)
...
[DEBUG-AUDIO] ✅ SENT chunk 0009 (9/9)

[DEBUG-RESULT] audio_chunk result: ..._0001 chunk=1 size=358KB
[DEBUG-CHUNK] completeChunk called: .../sc-e4da99bd chunk=1 phase=WAITING_CHUNKS
[DEBUG-CHUNK] Chunk completeness check: expected=9 present=[1] missing=[2,3,4,5,6,7,8,9] attempt=0/5

[DEBUG-CHUNK] Chunk completeness check: expected=9 present=[1] missing=[2,3,4,5,6,7,8,9] attempt=1/5
...
[DEBUG-CHUNK] Chunk completeness check: expected=9 present=[1] missing=[2,3,4,5,6,7,8,9] attempt=5/5
[DEBUG-CHUNK] ⛔ MAX RETRIES EXCEEDED: .../sc-e4da99bd expected=9 missing=[2,3,4,5,6,7,8,9]
```

GPU hub logs:

```
import_..._sc-e4da99bd_0002:audio Hub rejected result: HTTP 409
```

---

## 3. Root Cause

### 3.1 Retry Configuration (Before Fix)

```js
AUDIO_MERGE_RETRY_DELAY_MS: 15000,     // 15 seconds between retries
AUDIO_MERGE_RETRY_MAX: 5,              // maximum 5 attempts
AUDIO_MERGE_RETRY_DEDUP_TTL_S: 30,     // dedup key lives for 30 seconds
AUDIO_MERGE_RETRY_COUNTER_TTL_S: 180,  // counter lives for 3 minutes
```

Total retry budget: **5 × 15s = 75 seconds**.

### 3.2 Race Condition Timeline

With 9 chunks and 1 audio worker (~10-15 seconds per chunk via ComfyUI TTS):

```
t=0s:    executeAudioDispatch → setWaitingChunks → send 9 jobs → GPU hub
t=5s:    chunk 0001 processed → completeChunk(0001) → 1/9 → schedule retry in 15s (attempt 1)
t=15s:   retry #1 → 1/9 → schedule retry in 15s (attempt 2)
t=20s:   chunk 0002 processed by worker → result sent to GPU hub
         GPU hub checks animastor:running:{dispatch_id} → still present → forwards to backend
         Backend: chunk 0002 saved to disk
t=25s:   chunk 0003 arrives at backend → saved
t=30s:   retry #2: present=[1,2,3] missing=[4-9]
         ...
t=60s:   retry #4: present=[1,2,3,4,5] missing=[6-9]
t=65s:   chunk 0006 arrives → saved
t=75s:   retry #5: MAX RETRIES → failStage
         → orchestrator.failStage → cancelActiveDispatch
         → GPU hub cleans animastor:running:{dispatch_id}
t=75s+:  chunks 0007-0009 arrive at GPU hub
         → animastor:running gone → HTTP 409 → results don't reach backend
         → scene transitions to PENDING → scheduler re-dispatch → GOTO 1
```

**Key insight:** Chunks 0002-0006 **manage to** reach the backend before `cancelActiveDispatch`, but chunks 0007-0009 get a 409 because:

1. 9 chunks × 10-15s = 90-135s needed for complete processing
2. Retry budget: 5 × 15s = 75s
3. **75s < 90-135s** → retries exhausted before all chunks complete

### 3.3 Additional Issue: Dedup Key Expiration

`AUDIO_MERGE_RETRY_DEDUP_TTL_S: 30` — the dedup key prevents launching a second retry timer while the first is active. But the dedup key lives for 30 seconds while the retry timer fires every 15 seconds — with the original value this wasn't a problem.

**After increasing DELAY_MS to 60s**, the dedup key (30s) expired BEFORE the retry timer fired (60s). Arriving intermediate chunks found the expired dedup key, created new retry chains, and accelerated retry budget exhaustion.

---

## 4. Fix

### 4.1 Changes in `runtime-config.js`

| Parameter | Before | After | Rationale |
|----------|------|-------|-------------|
| `AUDIO_MERGE_RETRY_DELAY_MS` | 15,000 (15s) | **60,000 (60s)** | 9 chunks × 10-15s = 90-135s; new budget 5 × 60s = 300s ✅ |
| `AUDIO_MERGE_RETRY_DEDUP_TTL_S` | 30 | **120** | Dedup must survive retry delay: 120s > 60s (2× buffer) ✅ |
| `AUDIO_MERGE_RETRY_COUNTER_TTL_S` | 180 (3min) | **600 (10min)** | 5 × 60s = 300s; 600s > 300s (invariant) ✅ |

### 4.2 Invariant Verification

```js
// Invariant 1: MAX × DELAY_MS < LEASE_TTL_S.AUDIO × 1000
//   5 × 60,000 = 300,000ms < 15 × 60 × 1000 = 900,000ms ✅

// Invariant 2: COUNTER_TTL_S × 1000 > MAX × DELAY_MS
//   600 × 1000 = 600,000ms > 300,000ms ✅

// Invariant 3: DEDUP_TTL_S × 1000 >= DELAY_MS
//   120 × 1000 = 120,000ms >= 60,000ms ✅
```

Confirmed: the test `runtime-timeouts.test.js` verifies all three invariants.

---

## 5. Hypothesis Verification (Blind Search)

For debugging, logs were added at all critical points:

```
[DEBUG-DISPATCH] — executeAudioDispatch: dispatch and result
[DEBUG-AUDIO]    — generateSceneAudio: segments, expectedCount, chunk dispatch
[DEBUG-RESULT]   — handleTaskResult: each arriving result
[DEBUG-CHUNK]    — completeChunk: phase, completeness check, retry, max retries
```

Grep: `docker compose logs backend | grep '\[DEBUG-'`

---

## 6. Affected Files

| File | Change |
|------|-----------|
| `backend/src/config/runtime-config.js` | DELAY 15→60s, DEDUP 30→120s, COUNTER 180→600s |
| `backend/src/services/audio-orchestrator.js` | [DEBUG-CHUNK] logs |
| `backend/src/audio/generation.js` | [DEBUG-AUDIO] logs |
| `backend/src/services/task-handler.cjs` | [DEBUG-RESULT] logs |
| `backend/src/orchestration/scene-orchestrator.js` | [DEBUG-DISPATCH] logs |

---

## 7. Lessons Learned

1. **Fixed retry timers are unsuitable for async workers with variable load.** Ideally, retries should be adaptive: fail only when chunks stop arriving (no new chunks within N minutes), not by a fixed number of attempts.

2. **Dedup key TTL must be ≥ retry delay.** Otherwise intermediate events create competing retry chains.

3. **Debug logs with `[DEBUG-*]` prefixes are critical for diagnosing distributed races.** Without them, the root cause of the 8/9 loop would have been invisible.

---

## 8. Refactoring: Retry Timer Replaced by Event-Driven Model + Watchdog

Instead of increasing constants (the previous "fix"), the entire mechanism was replaced:

| Before | After |
|------|-------|
| `completeChunk` starts a `setTimeout` chain | Event-driven: arrival of the last chunk triggers merge |
| FAILED by timer (race with live generation) | FAILED only from `failWaitingScene()` (watchdog for stalls) |
| `AUDIO_MERGE_RETRY_*` (4 constants) | `AUDIO_CHUNK_STALL_MS` (single constant) |
| `animastor:audio-merge-retry:*` keys in Redis | Removed |
| `[DEBUG-*]` logs in 4 files | Removed (replaced by `helpers.log`/`warn`) |

### What Changed

1. **T-A1** (`197f838`): `completeChunk` with an incomplete chunk set writes `chunks_received`/`last_chunk_at` and exits. Merge is triggered only by arrival of the last chunk. `failWaitingScene()` is the sole owner of `WAITING_CHUNKS → FAILED` (hub-dedup cleanup + metadata reset + `orchestrator.failStage`).

2. **T-A3** (`134db6a`): retry constants replaced by `AUDIO_CHUNK_STALL_MS=300000` (5 min).

3. **T-A2** (`b7ad7fc`): watchdog `checkStalledAudioScenes` in `reconcileCycle` — phase B1. Scans all audio-orch states; for `WAITING_CHUNKS` checks `last_chunk_at + STALL_MS < now` → calls `failWaitingScene()`.

4. **T-A5** (`19eb680`): `[DEBUG-*]` logs removed from all 4 files.

5. **T-A6** (`74e2f45`): 5 new tests for watchdog; 576 tests passing.

Details: `docs/03-audit/AUDIO_ORCH_INTEGRATION_TODO.md`
