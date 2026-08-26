# Targeted Investigation: Video Re-Dispatch Incident (runtime evidence)

**Date:** 2026-08-26
**Book:** `import_1786345731767_1786345734345`
**Scenes:** `sc-a740d763` (page animation, `ch-1bb5123c`) + `sc-5f0068ca` (video
cover, `ch-37eadabb` — note: prior audit doc wrongly placed it in
`ch-1bb5123c`)
**Method:** live runtime evidence collected on the production VPS:
- Redis event journals (2,356 events for a740d763; 375,106 for 5f0068ca)
- current Redis state keys (asset-state hashes, video-orch, retry-budget,
  circuit breaker)
- backend docker logs covering the incident window
- output file mtimes on disk (`/data/output/build_*/`)
- PostgreSQL `scene_assets` schema/rows

All timestamps below are **real**, from logs/journals (UTC).

---

## Proven causal chain (sc-a740d763)

```
03:02:11 SCENE_RESET (marked=1 — only image!) → video per-asset state left at NEW
03:03:42 IMAGE_COMPLETED → image=ready
03:49:36 SCENE_RESET #2 (marked=1) + force-dispatch flag set (TTL 120s)
03:49:55 first DISPATCH_STARTED video; every dispatch logs:
         "[SET-GENERATING] video: new→generating rejected (invalid_asset_transition)"
         — rejection is IGNORED, job sent to hub anyway with per-asset state = new
03:50–03:51 force_reset churn: each 5s scheduler tick cancels the previous
         dispatch and enqueues a NEW job → ~19 duplicate hub jobs
         (hub dedup bypassed: dedup key includes dispatch_id)
03:52:09 [GPU RESULT] result ARRIVES (818KB b64) with the OLD dispatch_id
         (03:49:55!) → verifyDispatchIdentity: stale_dispatch → stale-ACCEPT
         (scene WAITING_CHUNKS) → _g1.mp4 saved (613901B, mtime 03:52:09.744 ✓)
         → completeGroup → merge → video-orch DONE
         (merged mp4 mtime 03:52:30 ✓)
03:52:30 handleVideoCompleted: "Invalid per-asset state: new
         (expected GENERATING/PENDING)" → ok:false invalid_asset_state
         → FINALIZE_FAILURE + BUDGET_CONSUMED(remaining 4)
03:52:12–03:53 three more cycles: cache-hit → fast-track merge → DONE →
         reject → failure → budget 5→0 → circuit breaker OPEN
after    circuit stuck in half_open ("half_open_limit_reached"): test
         dispatches are rejected by retry budget BEFORE recordSuccess/
         recordFailure → half-open permit leaks → BOTH video stages blocked
         indefinitely (floods: 1,854 BLOCKED events on a740d763;
         ~155k RETRY_BUDGET_EXCEEDED historically on 5f0068ca)
```

Three independent sources agree second-for-second: file mtimes, journal
events, and `animastor:circuit:video:last-failure` = 1787716350783 =
03:52:30.783.

## Hypothesis verdicts

| Hypothesis | Verdict |
|------------|---------|
| A — version gate (READY/DONE → DIRTY → re-dispatch) | **REFUTED**: zero `VERSION-DIRTY` log lines in the incident window; image stayed ready; PG versions not involved |
| B — lost success callback | **REFUTED** (literal form): callback arrived, was accepted via stale-accept, file saved, merge completed. Nothing was lost — **success was converted into failure by state validation** |
| C — lease expiry | **REFUTED**: no backend restart through the incident (container Up 37h); leases renewed every 30s (RENEWED log lines); all cancellations were explicit `force_reset` |

## Root cause (proven)

Per-asset video state was stuck at `new`, and the whole pipeline ran around it:

1. SCENE_RESET marked only image (`marked=1`); video never initialized → `new`.
2. `startScene` skipped: `isNewScene` requires ALL THREE assets NEW; image was
   already ready.
3. `setSceneGenerating`: transition `new → generating` is invalid per the
   transition map (`NEW → {DIRTY, PENDING, PLACEHOLDER}`) — the rejection is
   logged and swallowed; the job is sent anyway.
4. The result was delivered successfully, but `handleVideoCompleted` accepts
   only `{GENERATING, PENDING, DIRTY}` → success rejected as
   `invalid_asset_state` → recorded as FAILURE → retry budget burned ×5 →
   circuit stuck half_open → both video scenes permanently blocked.

## First incorrect state transition

`video: new → generating` — rejected and ignored instead of initializing
`new → pending → generating` before sending the job.

## Exact locations

- `backend/src/orchestration/scene-orchestrator.js : dispatchStage` —
  `isNewScene` gate skips initialization; `setScenePending` runs only when
  `dispatched=false`.
- `backend/src/orchestration/orchestrator.js : setSceneGenerating` — rejection
  swallowed.
- `backend/src/orchestration/scene-callbacks.js:365 : handleVideoCompleted` —
  whitelist without `new`; converts success into failure.
- `backend/src/state/scene-state.js : AssetTransitions` / scene-reset logic —
  incomplete initialization after reset.

Also documented (same bug family):
- Cover scene `sc-5f0068ca` has been burning on the identical pattern since
  **Aug 13** with stage audio (`invalid_asset_state` on Aug 14, force_reset
  churn Aug 14/Aug 25, ~17k RETRY_BUDGET_EXCEEDED/day for two weeks).
- Per-minute flood of `image ready→pending ignored` INVALID_STATE_CALLBACKs
  originates from reconciliation self-heal calling `setScenePending` on READY
  assets.

## Open items

- GPU worker logs (external instance) would confirm ComfyUI node-cache hit on
  the worker side during re-dispatch (the 404 tail), but this does not affect
  the root cause.
- Cover scene video retry-budget = 0 despite zero journaled video failures —
  verify `retry-budget-manager` key scope/TTL (suspect cross-stage or stale
  consumption predating the journal window).

No code changes were made; no patches proposed in this document.
