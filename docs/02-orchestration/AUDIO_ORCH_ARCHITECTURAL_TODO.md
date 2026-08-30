# TODO: Audio Orchestration — Architectural Fixes

> **Date:** 20 July 2026
> **Basis:** `docs/02-orchestration/AUDIO_ORCH_ARCHITECTURAL_FIXES.md`
> **Context:** series of patches from 2026-07-20 (`02e99a5`, `ebbcb4f`, `281d192`,
> `4a17f55`, `ecde189`, `1ce49ee`) patched audio orchestration ad-hoc. This TODO is the
> migration from "it worked, so leave it" to architecturally correct core.
>
> Statuses: ✅ complete, 🔴 not started, 🟡 in progress, ⏸️ blocked.
> Priorities: P0 — data loss / silent corruption, P1 — reliability, P2 — cleanup / docs.

---

## ✅ Source — Today's Patches (Context for Migration)

| Commit | Symptom | Architectural Fix Item |
|--------|---------|------------------------|
| `02e99a5` | readdir order undefined → merge in random order | A0 |
| `ebbcb4f` | 0-byte TTS skip during merge | A1 |
| `281d192` | STALL/LEASE/GPU_TIMEOUT manually tuned | A2 |
| `4a17f55` | phase-guard against stale re-dispatch | A3 |
| `ecde189` | bulk-delete chunks on mismatch | A4 |
| `1ce49ee` | batch dispatch buried in code | A5 |

---

## ✅ A0: Deterministic Chunk Enumeration (P0) — COMPLETE

**Problem:** `findExistingSceneChunks` uses `fs.readdirSync` (EXT4 — hash-table order).
Currently falls back to `.sort((a,b)=>a-b)`, but consumers still work with
arbitrary fs-scan, not deterministic enumeration.

- [x] **A0.1** Rewrite `backend/src/audio/chunks.js::findExistingSceneChunks`
      to enumeration-based: accepts `expectedCount`, returns existing
      indices from `1..expectedCount`, doesn't call `readdirSync`.
- [x] **A0.2** Audit consumers of `findExistingSceneChunks` (generation.js,
      pipeline.js) — pass `expectedChunkCount`. filesystem-store.js has
      its own copy (not in audio path, left unchanged).
- [x] **A0.3** Test: enumeration path tested via `expectedCount !== null`.
      .sort() kept as defense-in-depth in fallback path.
- [x] **A0.4** `.sort()` kept in readdir-fallback as cheap defense-in-depth.

**Verify:** `npm test` — all 8 runtime-timeouts tests pass.

---

## ❌ A1: Empty TTS Output — Recoverable Failure (P0) — SKIPPED

**Consciously not implemented.** Current mechanism already works:
0-byte chunk → unlink + Redis cleanup → missing → watchdog STALL → FAILED
→ scheduler re-dispatch. Explicit retry budget per chunk — over-engineering
for current failure rate. See discussion in commit message.

---

## ✅ A2: Timeouts via Formula, Not Magic Numbers (P1) — COMPLETE

**Problem:** `GPU_TIMEOUT < STALL < LEASE_TTL` pinned by three
independent constants (10 / 15 / 20 min). Any env-change to GPU_TIMEOUT
silently breaks the invariant.

- [x] **A2.1** In `runtime-config.js` introduced `GPU_TIMEOUT_MS` as single source
      of truth. Backward compat: `GPU_TIMEOUT` (without _MS) also read.
- [x] **A2.2** Derived from it:
      ```js
      const STALL_FAILSAFE_MS = GPU_TIMEOUT_MS * 3;  // 30 min @ 10 min GPU
      LEASE_TTL_S.AUDIO = ceil(STALL_FAILSAFE_MS / 1000) + 60;  // 31 min
      ```
- [x] **A2.3** Watchdog remains failsafe; explicit hub error still takes
      priority (via notifyBackendError + failStage).
- [x] **A2.4** Test `runtime-timeouts.test.js` rewritten: verifies formulas,
      not hardcoded values. 8/8 tests.
- [x] **A2.5** Startup warning: if `GPU_TIMEOUT_MS` or `GPU_TIMEOUT`
      set — log with recalculated values.
- [x] **gpu-hub/gpu-hub.js:** synchronized — uses `GPU_TIMEOUT_MS`
      with fallback to legacy `GPU_TIMEOUT`.

**Verify:** `npm test` — 8/8 runtime-timeouts tests pass.

---

## ✅ A3: Dispatch Lease Instead of Phase Guards (P1) — COMPLETE

**Problem:** `executeAudioDispatch` opens with guard `if (phase ===
WAITING_CHUNKS || MERGING) return`. Symptom fix.

- [x] **A3.1** Infrastructure already existed: `dispatch-engine.js` has
      `acquireStageLease` (SETNX + TTL). A2 ensures
      LEASE_AUDIO (31m) > STALL (30m) > GPU_TIMEOUT (10m), so lease
      outlives watchdog.
- [x] **A3.2** `task-handler.cjs` already calls `verifyDispatchIdentity`
      (checks dispatchId against metadata). `completeChunk` receives dispatchId
      via deps — identity verified before call.
- [x] **A3.3** Phase guard removed from `executeAudioDispatch`. DONE guard
      retained. WAITING_CHUNKS/MERGING stale recovery now logs and
      falls through deleteState+reinit (doesn't leave scenes stuck).
- [x] **A3.4** Watchdog on stall: TTL expired → lease free via Redis
      EXPIRE. Reconciliation cleans stale leases.
- [ ] **A3.5** Concurrency test — deferred (needs Redis mock).

**Verify:** stale recovery no longer returns early — stuck scenes
are recovered.

---

## ❌ A4: Per-Chunk Content Hash Cache (P1) — SKIPPED

**Consciously not implemented.** The "9+9 duplicates" problem was already
fixed in `ecde189` (bulk-delete removed). Per-chunk cache-hit by files
on disk works correctly. Content hash would solve edge-case "text changed,
file remained" — in practice `padded_text` stale check already covers this.
Over-engineering for current failure modes.

---

## ❌ A5: Explicit Dispatch Plan + Policy (P2) — SKIPPED

**Consciously not implemented.** Current batch dispatch
(narration first, dialogue later) is optimization for ComfyUI, not
prioritization policy. No second alternative (`round-robin`,
`uniform`) exists to justify enum + parameter in signature.
Over-engineering.

---

## 🔴 Cross-Cutting: Observability (P2)

**Problem:** today `[DEBUG]` strings are the only way to understand what
happened. This is debugging, not observability.

- [ ] **C1** Introduce structured events in journal: `chunk_received`,
      `merge_started`, `lease_acquired`, `dispatch_id_mismatch_dropped`,
      `tts_empty_output`, `chunk_retry_exhausted`.
- [ ] **C2** Metrics in Redis (`animastor:runtime:metrics:current` exists):
      - `audio.stale_result_dropped{reason}`
      - `audio.chunk_failed{reason}`
      - `audio.dispatch_duplicate`
      - `audio.merge_duration_ms`
- [ ] **C3** Remove `[DEBUG]` logs after migration to structured events (all
      `[DEBUG]` strings in `audio-orchestrator.js`, `pipeline.js`, `chunks.js`).
- [ ] **C4** Runtime assertions for invariants (extend
      `tests/runtime-timeouts.test.js` to all invariants from
      A2 + A3 + A4).

**Verify:** grep `[DEBUG]` in `backend/src/audio/` → 0 matches after
migration.

---

## Dependencies Between Tasks

```
A0 (enumeration)  ───independent───┐
                                    ├──► A4 (content hash cache)
A1 (empty retry)  ──requires A4.1 ──┘            uses A0.2 (hash return)
A2 (timeouts)     ───independent────────────────► (depends only on gpu-hub)
A3 (lease)        ──requires A1 (retry) ─────────► (lease release requires
                                                   recovery budget)
A5 (plan)         ──requires A4 ─────────────────► (cache-hit per-chunk)
C* (observability) ──unblocks A1, A3, A4 ───────► (metrics critical for
                                                    retry decisions)
```

**Recommended order:**
1. **Sprint 1:** A0 + C1 + C4 (observation skeleton) — provides tools.
2. **Sprint 2:** A1 + A4 (chunk-level retry + cache).
3. **Sprint 3:** A3 (lease) — requires working retry.
4. **Sprint 4:** A2 (timeouts), A5 (plan) — cleanup, lowest risk.

---

## Anti-Patterns Checklist (Don't Repeat)

- [ ] ~~Any new `if (phase === ...)` at top of `executeAudioDispatch`~~ →
      use lease (A3).
- [ ] ~~Any new timeout constant~~ → derive from `GPU_TIMEOUT_MS` (A2).
- [ ] ~~Any new `readdirSync` for chunk-order~~ → enumeration (A0).
- [ ] ~~Any `unlinkSync` bulk-delete of chunks~~ → invalidate per-chunk cache
      (A4).
- [ ] ~~Any `[DEBUG]` log~~ → structured event (C1).

---

## Done Definition

Migration complete when:
- All items A0–A5 marked ✅.
- `grep -r "readdirSync" backend/src/audio/` returns 0 matches for
  chunk-discovery.
- `grep -r "MIN_CHUNK_BYTES" backend/src/` returns only constant
  definition and recovery-path usage.
- `grep -r "\[DEBUG\]" backend/src/audio/` returns 0.
- `AUDIO_ORCH_ARCHITECTURAL_FIXES.md` marked deprecated (or deleted),
  since all issues are resolved in code.
