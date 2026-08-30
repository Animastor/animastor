# Player Audio Master Timeline — TODO

> **Legend:** 🟡 High | 🟢 Medium | ⚪ Low
> **Status:** 📝 Plan | 🔧 In progress | ✅ Done | ❌ Skipped

Source: `docs/03-audit/PLAYER_AUDIO_MASTER_TIMELINE.md`

---

## Phase 1: Constrain reveal gate to unit boundaries (🟡 High)

**Problem:** `pendingRevealPosMs = startPosMs + 150` (Android `PlayFragment.kt:1237,1245`;
Web `playbackStore.ts:1434,1494`) only checks the lower bound. A short unit (< 150 ms)
reveals the video in the next unit.

### [T1.1] Add upper bound to reveal gate
- [x] Android: in `startIuCycling`, add `pos < unitEnd` (or `min(start + tol, unitEnd - safety)`)
  to the reveal condition (`PlayFragment.kt:1076-1082`). Take the bound from the next unit's
  `startMs` or `end_ms` (`StoryboardResponse.kt:21`).
- [x] Web: in `onVideoTimeUpdate`, add upper bound (`playbackStore.ts:1556-1564`).
- [x] Fallback: if the last unit has no next `startMs` — use
  `startMs + durationMs`.

### [T1.2] Verify bound on the last unit of a scene
- [x] Seek to the last unit of a scene: reveal must not fly past scene end / into `ended`
  (covered by `unitEndMs`: last unit → `startMs + durationMs`; manual check — in T4).

---

## Phase 2: Race first-frame vs position gate (🟡 High)

**Problem:** On Web, `onVideoTimeUpdate` reveals based on `currentTime` alone without checking
the actual decoded frame (`playbackStore.ts:1556-1564`, `videoHasFrame = true` is set
purely by position). Android reveals based on position without `onRenderedFirstFrame` in the seek path.

### [T2.1] Align both platforms to AND
- [x] Web: in `onVideoTimeUpdate`, before reveal, ensure the frame is actually decoded
  (e.g., `videoHasFrame || readyState >= HAVE_CURRENT_DATA`).
- [x] Android: document the decision — seek-reveal by position is sufficient (README/comment),
  or add a render check.

### [T2.2] Test scenarios
- [x] Seek → first frame present, position < gate → don't show.
- [x] Position >= gate, first frame not ready → don't show.
- [x] Both conditions met → show.

Implemented as unit tests on BOTH platforms (gate logic extracted to pure
modules, `shouldRevealSeekVideo` — pure AND function, used in runtime
Android: `startIuCycling`; Web: `onVideoTimeUpdate`):
- Web: `frontends/app/src/state/playbackGate.ts` + `playbackGate.test.ts` (vitest —
  14 tests: 3 AND gate scenarios + `unitRevealGateSec` clamping — short unit,
  last unit, legacy-cumulative, fallback without bounds).
- Android: `PlayerGate.kt` + `PlayerGateTest.kt` (JUnit 4, `:app:testDebugUnitTest` —
  16 tests: same scenarios + `unitRevealGateMs`/`unitStartMs`/`unitEndMs`).

---

## Phase 3: Invariant currentIuIndex vs unitId (🟡 High)

**Problem:** index remains operational state; stale index possible after
pause/resume/rotation/restore.

### [T3.1] Verify invariant
- [x] After every transition (seek, pause, resume, rotation, scene transition, Navigator)
  verify: `ius[currentIuIndex].unitId == targetUnit.unitId`.
- [x] Cover guard `idx == 0 && currentIuIndex != 0` (`PlayFragment.kt:1109`).

**Conclusion:** Invariant holds constructively — both platforms derive
`currentIuIndex` from `resolveUnitIndexForSequence` in `handleChunk` (unitId-first, fallback index),
meaning the index is re-computed on each scene entry, not copied from the store.
Guard `idx == 0 && currentIuIndex != 0` is correct protection against transient `pos == 0`
immediately after seeking to a later unit (its `start_ms > 0`); when seeking to unit 0
`currentIuIndex == 0`, and the guard doesn't fire. Manual regression — T4.

---

## Phase 4: Regression scenarios (🟡 Test)

Run after phases 1-3 on both platforms:

- [ ] Cold start → Navigator → very fast tap → Start → pause → different unit.
- [ ] Pause → Navigator → unit → Play.
- [ ] Last unit → first unit of the same scene.
- [ ] Scene A → Scene B → quickly back to Scene A.
- [ ] Positioned-pause at a unit boundary (Android vs Web behavior).
- [ ] Short unit (< 150 ms): reveal not in the next unit.

---

## Phase 5: Separate the two semantic `150` values (🟢 Medium)

- [x] Android: rename/extract `delay(150)` in `revealVideoAfterReturn`
  (`PlayFragment.kt:1482`) into a separate named constant (e.g.,
  `SURFACE_RE_RENDER_FALLBACK_MS`), distinct from `UNIT_REVEAL_TOLERANCE_MS`.
- [x] Web: confirm `UNIT_REVEAL_TOLERANCE_MS` is the only 150 value.

---

## Phase 6: Formalize Player state machine (🟢 Later)

**Problem:** Many independent flags (`PlayFragment.kt:85-140`) instead of a single
source of truth for selectedUnit.

- [x] Document states: `IDLE / LOADING_SCENE / SHOWING_STORYBOARD / SEEKING /
  VIDEO_READY / PLAYING / PAUSED`.
- [x] Consolidate flags into a single source of truth for selectedUnit: the
  `currentIuSequence`/`currentIuIndex` pair replaced by a unified `selectedUnit`
  (Android: `SelectedUnit(sequence, index)` in `PlayFragment.kt`; Web: `selectedUnit`
  in `playbackStore.ts`). 7 states implemented as stored state
  (`playerState` + `transition()`; transition table in the design doc).
- [x] Demote semantic flags: `isPaused`, `videoReadyToShow`/`videoHasFrame`,
  `videoSeekInFlight`, `pendingRevealPosMs`/`pendingVideoRevealSec` became
  read-only state accessors; all writes replaced by `transition()`
  (`SEEKING` carries payload: `revealGateMs` / `seekLanded` / `paused`).
  Guard/one-shot fields (`advancePending`, `pendingLoad`, `pendingRevealGen`,
  generations, `videoSurfaceAlive`, `sceneTransitionPending`/`nextChainReady`,
  `videoEnded`) remain as per the design doc table.
- [x] No new flags before this refactor.

Design: `docs/05-frontend/PLAYER_STATE_MACHINE_DESIGN.md`.

---

## Phase 7: Future rule — video_start_ms (⚪ Doc)

- [x] Document in DONT_DO.md: **Player must never depend on `video_start_ms`**;
  LTX 8N+1 is resolved during video preparation/assembly.
- [x] Verify frontend models are clean (no `videoStartMs` remaining).

---

## Progress

| Task | Status |
|---|---|
| T1.1 Reveal gate with upper bound | ✅ Done |
| T1.2 Last unit of scene | ✅ Done (code; manual test — T4) |
| T2.1 AND first-frame + position | ✅ Done |
| T2.2 Gate test scenarios | ✅ Done (Web: vitest 14/14; Android: JUnit 16/16) |
| T3.1 Invariant index vs unitId | ✅ Done (verify) |
| T4 Regression scenarios | 📝 Plan |
| T5 Separate two 150 values | ✅ Done |
| T6 State machine | ✅ Done (selectedUnit — single source of truth; 7 states — stored state + transition(); semantic flags demoted to accessors) |
| T7 video_start_ms rule | ✅ Done |
