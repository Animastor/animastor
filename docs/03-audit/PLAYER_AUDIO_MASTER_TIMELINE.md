# Player Audit: Unified Audio Timeline and Reveal Gate (n−1)

Date: August 17, 2026
Base commits: `413a841` (unified audio timeline), `7b58152` (unitId instead of index)
Platforms: Android (`PlayFragment.kt` / `PlaybackViewModel.kt`), Web (`frontends/app/src/state/playbackStore.ts`)

---

## Summary

The last refactor — correct architectural direction. Player lives on the audio master
timeline (`start_ms`), storyboard belongs to the selected unit, video is a subordinate
visualization (`follower`) that reveals only after the position has actually
landed inside the selected unit (position-based reveal gate). LTX-specific alignment
(`video_start_ms`) is correctly extracted to backend/video profile/assembly.

Audit confirmed the contract:

```
AUDIO → MASTER TIMELINE → STORYBOARD (selected IU) + VIDEO (follower) → PLAYER

LTX chunks → 8N+1 correction → normalized video → Player / Final Export
```

Several areas were found that should be verified / documented.

---

## 🟢 What Looks Good (code-confirmed)

1. **Audio master timeline.** `unitStartMs()` on both platforms reads only `start_ms`
   (Android: `PlayFragment.kt:810-818`; Web: `playbackStore.ts:1154-1160`). `video_start_ms`
   is completely removed from Player.
2. **unitId instead of Navigator indices.** Target resolution by ID against storyboard sequence:
   `resolveUnitIndexForSequence` (Android: `PlaybackViewModel.kt:753-760`; Web:
   `playbackStore.ts:1166-1173`). Index remains only as fallback.
3. **Storyboard selected unit as transition overlay.** `showIuImage(iuSequence[seekToUnit])`
   before `targetScene` (Android: `PlayFragment.kt:756`; Web: `playbackStore.ts:1096-1103`).
4. **Video reveals after seek, not immediately after source assignment.** Position gate
   `startPosMs + tolerance`: Android `PlayFragment.kt:1076-1082`, Web `onVideoTimeUpdate`
   `playbackStore.ts:1556-1564`.
5. **`video_start_ms` extracted from Player.** Frontends no longer consume it (models are clean);
   backend continues computing best-effort (`backend/src/video/video-timeline.js:229,294`;
   `generation-routes.cjs:885-894`) for Final Assembly. The separation is correct.
6. **Cold-start is covered.** `pendingExternalSeek` is deferred until queue readiness
   (Android: `PlaybackViewModel.kt:300-311, 685-745`; Web: `playbackStore.ts:589-625`).

---

## 🟡 What Should Be Investigated

### 1. Magic +150 ms and unit boundaries — PRIORITY #1

Current flow:

```
unit N starts at audio T
   ↓
seek video → T
   ↓
storyboard unit N covers the surface
   ↓
wait for video position >= T + 150 ms
   ↓
show video
```

Both platforms only check `pos >= target + 150`, **upper unit boundary not checked**:

- Android: `pendingRevealPosMs = startPosMs + UNIT_REVEAL_TOLERANCE_MS`
  (`PlayFragment.kt:1237, 1245`), reveal at `pos >= pendingRevealPosMs` (`PlayFragment.kt:1076-1082`).
- Web: `pendingVideoRevealSec = explicitSeekMs/1000 + UNIT_REVEAL_TOLERANCE_MS/1000`
  (`playbackStore.ts:1434, 1494`), reveal in `onVideoTimeUpdate` at `currentTime >= pendingVideoRevealSec`
  (`playbackStore.ts:1556-1564`).

If a unit is shorter than 150 ms, the position `T + 150` is already in the next unit. Reveal must
be constrained to the current unit's boundaries:

```text
revealPosition = min(unitStart + tolerance, unitEnd - safetyMargin)
```

Or reveal by conditions: `seek completed AND video has frame AND pos >= unitStart + tolerance
AND pos < unitEnd`. Unit boundary can be obtained from `end_ms` (`StoryboardResponse.kt:21`)
or from the next unit's `startMs`.

**Don't turn 150 ms into a universal truth.** For a different profile/model, drift may
be 250 ms; for a short unit — we jump past the end. Only `REVEAL_SAFETY_TOLERANCE`
and a check that we're still inside the selected unit.

### 2. 150 ms simultaneously in visual logic and timing logic

`UNIT_REVEAL_TOLERANCE_MS = 150` (Android: `PlayFragment.kt:56`; Web: `playbackStore.ts:176`) —
this is the reveal gate. But on Android there is a **second, separate** `delay(150)` in
`revealVideoAfterReturn()` (`PlayFragment.kt:1482`) — visual fallback on a recreated surface.
These are different semantics of the same value, hardcoded in two places. Worth separating
constants/comments so `150` doesn't become "used for everything."

### 3. Android vs Web — different synchronization mechanisms

- Android: single ExoPlayer + `MergingMediaSource` — audio and video under one media clock
  (`PlayFragment.kt:68-77, 1255-1266`).
- Web: separate `<audio>` and `<video>` (`currentPlayer` + `videoEl`).

This is a deliberate platform architecture, not a bug. But requiring Web to match Android
byte-for-byte is impossible: on Web there will always be a small independent drift between
two HTML media elements. Contract: **Audio = semantic master timeline, Video = visual follower**.

### 4. Player knows too many video states

Too many independent flags have accumulated:

```
videoReadyToShow, videoSeekInFlight, pendingRevealPosMs, pendingRevealGen,
videoPlayerGeneration, videoCurrentGen, videoSurfaceAlive,
currentPlayerVideoVersion, currentPlayerHasVideo, currentPlayerSceneKey,
currentIuSequence, currentIuIndex, advancePending, pendingLoad, ...
```

`PlayFragment.kt:85-140`. This is exactly the code that spawned n−1 (chain `currentIuSequence →
stopAll → null → SCENE_READY → different picture`). Currently nothing is broken, but don't
add new flags even for edge cases. Next step — formalize states:

```
IDLE / LOADING_SCENE / SHOWING_STORYBOARD / SEEKING / VIDEO_READY / PLAYING / PAUSED
```

and a single source of truth for selectedUnit.

### 5. `currentIuIndex` vs `unitId` — invariant

Target resolution by ID is the correct primary path. But index remains operational state
(cyclic playback). Verify the invariant:

> At any moment, `currentIuIndex` must be the index of the same object that
> is identified by `currentUnitId` (in Android — the target unit from `resolveUnitIndexForSequence`).

Otherwise, through `pause → resume → scene transition → Navigator → rotation → restore` you can again
get a stale index. Especially worth covering with tests: `idx == 0 && currentIuIndex != 0`
(`PlayFragment.kt:1109`) — a guard that forcefully prevents the index from rolling back to unit 0.

### 6. `video_start_ms` — future rule

Backend continues computing `video_start_ms` (best-effort) for Final Assembly. This is good.
Architectural rule: **Player must never depend on `video_start_ms` again**,
otherwise the n−1 epic will return through "just for this one edge case."

### 7. Race: first frame + position gate

Two conditions: "video rendered first frame" and "position reached reveal gate." It must be
AND, not two independent opportunities to reveal video.

- Android: reveal by position — first frame is not required (`PlayFragment.kt:1076-1082`);
  `onRenderedFirstFrame` only serves the return path (`PlayFragment.kt:1371-1381`).
- Web: `onVideoFirstFrame` doesn't reveal while `videoSeekInFlight` (`playbackStore.ts:1543-1547`),
  and `onVideoTimeUpdate` reveals by position **without checking the actual frame**
  (`playbackStore.ts:1556-1564` — `videoHasFrame = true` is set purely by currentTime).

On Web there's a subtle case: currentTime may cross the gate before frame decode. Low frequency,
but this spot should be tested separately.

### 8. Scenarios to run after changes

1. Cold start → Navigator → very fast tap → Start → pause → different unit.
2. Pause → Navigator → unit → Play.
3. Last unit → first unit of the same scene.
4. Scene A → Scene B → quickly back to Scene A.
5. Positioned-pause at a unit boundary (Android reveals by position before `isPaused` gate
   `PlayFragment.kt:1076` vs `1084`; Web only on `timeupdate`, i.e. doesn't reveal when paused).
   Potential platform divergence.

---

## 🔴 What NOT to Do

- Don't touch the unified audio timeline idea — it's a good foundation.
- Don't bring `video_start_ms` back into Player, even if the specific LTX test again shows
  a couple of n−1 frames. Look only through the contract "storyboard = selected unit; audio =
  master; video = follower", and resolve LTX 8N+1 during video preparation/assembly.

---

## Files Affected by the Refactor (413a841, 7b58152)

| File | Role |
|---|---|
| `frontends/android/.../ui/PlayFragment.kt` | Position-based reveal gate, `UNIT_REVEAL_TOLERANCE_MS`, unitId-seek, watchdog READY |
| `frontends/android/.../ui/PlaybackViewModel.kt` | `resolveUnitIndexForSequence`, `pendingExternalUnitId`, deferred seek |
| `frontends/android/.../repository/StoryboardResponse.kt` | `end_ms` (useful for unit boundary) |
| `frontends/app/src/state/playbackStore.ts` | Web parity for reveal gate, `resolveUnitIndexForSequence` |
| `backend/src/video/video-timeline.js` | `video_start_ms` for Final Assembly (not for Player) |
| `backend/src/routes/generation-routes.cjs` | Serves `video_start_ms` best-effort |

---

## Priority Ranking

| # | Finding | Priority |
|---|---|---|
| 1 | +150 ms may jump past short unit end — upper bound needed | 🟡 High |
| 2 | Race first-frame vs position gate (Web reveals by currentTime alone) | 🟡 High |
| 3 | Invariant `currentIuIndex` vs unitId (especially guard `idx==0`) | 🟡 High |
| 4 | Cold-start / Navigator / Play race after recent changes | 🟡 Test |
| 5 | Pause → Navigator → unit → Play | 🟡 Test |
| 6 | Last unit → first unit of same scene | 🟡 Test |
| 7 | Scene A → Scene B → quickly back to Scene A | 🟡 Test |
| 8 | Formalize Player state machine (7 states) | 🟢 Later |
| 9 | Separate two semantic `150` values (reveal gate vs `revealVideoAfterReturn`) | 🟢 Later |
