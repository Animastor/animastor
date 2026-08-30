# Player: Unit-based Positioning of Whole Scene Video (Engineering Documentation)

This phase involved diagnosing and fixing the video seek mechanism when selecting a unit through
the Navigator, as well as layer switching (video/storyboard). This document records not only
the final solution but also the diagnostic path, so that if the problem recurs, you don't have to
repeat all experiments.

Final state is captured by commit `43df034` (Android) + `dd7478e` (web),
with documentation and temporary debug removal on top (`this commit`).

---

## 1. Current Player Architecture

A scene is played by **two independent media elements** (one per timeline):

| Stream | Android | Web |
|---|---|---|
| Audio | `MediaPlayer` (`currentPlayer`), whole scene audio file | `<audio>` |
| Video | `MediaPlayer` (`videoPlayer`), whole scene video file | `<video>` |

- **Whole scene video file** — one `.mp4` per scene (all units concatenated), created by
  the backend during merge: `backend/src/video/video-merge.js` — `alignGroupClips`
  (aligning clips to exact audio frames) + `forceKeyframesAtUnitBoundaries`
  (keyframe at each unit boundary), module `video-timeline.js` + tests.
- **Whole scene audio file** — one audio file per scene.
- **Canonical timeline** — audio (`start_ms` from server storyboard).
  The whole video is aligned to this same axis during the merge stage: the final muxed file
  has a unified time scale, so both audio and video seek to the same position.
- **Modular unit timestamps** — each unit has `start_ms` (and `duration_ms`).
  The "unit → position in whole video" mapping is calculated by `unitStartMs()`:
  server `start_ms` is used; for legacy storyboards without timestamps — cumulative
  sum of `duration_ms` of previous units.

Positioning entry points (`frontends/android/.../ui/PlayFragment.kt`,
`frontends/app/src/state/playbackStore.ts`):

```
Navigator/Edit unit tap
  → PlaybackViewModel.seekToPosition(chapterId, sceneId, unitIndex, unitId)
      → pendingExternalSeek = ActivePosition(...), currentIndex = idx
  → executePendingSeek()
      → explicitVideoSeekPending = true   ← video seeks EXPLICITLY (including 0)
      → SharedPositionManager.navigateTo(seek)
      → phase = DOWNLOADING, clear storyboard-cache and preloadCache, refetch scene
      → playNext() → scene chunk → handleChunk()
  → handleChunk()
      → seekToUnit = targetUnit (from SharedPositionManager) else 0
      → seekMs = unitStartMs(iuSequence, seekToUnit)   ← calculate on audio axis
      → if video present: playVideoOverlay(bytes, seekMs, explicitVideoSeek)
  → build video player → onPrepared → seekTo(target, SEEK_CLOSEST)
      → paused: poll-in-pause until position confirmed → peek-render (start→pause)
      → playing: confirm seek → start()
```

Scene start, middle, and end are handled identically: target is explicit, including `0`
for unit 1 / scene start (`explicitVideoSeekPending` — web parity; without it, seek
to 0 fell into the "sync with audio" branch and could be skipped).

---

## 2. Issues Found (chronology)

1. **Off by one unit:** selecting Nth unit → video showed position of N-1th
   (e.g., 3rd unit displayed 2nd). First units started from beginning/black frame.
2. **Seek sometimes not executed at all:** unit was selected, video stayed at current
   position.
3. **"Wrong position first, then correct":** video started playing from
   wrong position, then forced polling moved it to the correct
   timestamp.
4. **Layer switching (video → storyboard → video):**
   - in pause, video did not return — storyboard image remained;
   - in playback, video froze ("ran away" from audio by several seconds) or returned
     to wrong position and shifted on its own.
5. **Mid-unit desync on restore:** position within a unit (not at boundary) landed
   on previous unit's keyframe.
6. **Flash during unit navigation:** brief flash of unit image / cover / black
   screen before video frame appeared.
7. **Web (separate):** first click on 1st unit sometimes didn't seek to beginning;
   navigation within scene reloaded video element → flash.

---

## 3. Causes and Mechanisms (what was investigated)

| Cause | Mechanism |
|---|---|
| **Keyframe-aligned seek** | Default `seekTo` lands on nearest keyframe BEFORE target. Mid-unit = previous unit start → "unit shift". Unit targets land exactly because keyframes are now at unit boundaries (merge, profiled — `video.requiresKeyframeForcing`). |
| **Race: seekTo ↔ start()** | `start()` before async seek completes "drops" the seek — video plays from 0/stale frame. |
| **Paused MediaPlayer doesn't render new frame** | After seek in pause, surface holds old frame (previous unit) — "one unit shift" is visible even though `currentPosition` is accurate. Peek-render (start→pause) is needed. |
| **Hiding SurfaceView kills surface** | `INVISIBLE` destroys surface → MediaPlayer stops and enters broken state; cannot "revive" it — must recreate the player. |
| **Rebuild+seek always produces residual desync** | While video is recreated/seeked, audio continues playing; residual ≈ seek duration. Only fix: "don't touch video during layer switching" (web paradigm). |
| **Cache/stale data** | Excluded via full clean rebuild + app cache/data clear (bug reproduced from scratch). |
| **Index instead of unit_id** | Investigated path "Navigator → selected unit → its identifier → timestamp": shift was caused by keyframe alignment, not index logic. |
| **Two independent clocks drifting** | Audio and video run at slightly different speeds (~0.7% on device) — by end of scene, video leads by ~0.5s. |

---

## 4. Applied Fixes (final solution)

### Android (`PlayFragment.kt`, `PlaybackViewModel.kt`)
1. **Explicit unit-target, including 0** — `explicitVideoSeekPending`: video seeks
   directly to unit target (web parity), not via "sync with audio".
2. **`SEEK_CLOSEST` (API 26+)** — exact frame for mid-unit positions (otherwise keyframe
   of previous unit); fallback for older APIs.
3. **Poll-in-pause + peek-render** — after seek in pause: poll `currentPosition` until
   seek lands (re-seek on reset), then short `start()`+`pause()`,
   so the exact target frame is rendered on surface. No race with `start()`.
4. **Layer switching without player recreation (z-order)** — surface is **never
   hidden**; storyboard layer is brought ABOVE the surface viewport
   (`bringToFront()`). Video continues playing hidden and returns already
   synchronized with audio (web paradigm: `display:none` doesn't touch element).
5. **`keepSurface` on unit-seek** — old frame held on live surface while
   new player prepares; new frame replaces it directly — no cover, no black
   screen, no flash. Storyboard is not shown during video playback.
6. **Speed-lock (`setPlaybackParams`)** — adaptive video speed correction to
   match audio (every ~8s, measuring `dv`/`da` increments, clamped [0.9, 1.1]); drift limited
   without visible jumps (not polling-seek!).
7. **`syncVideoFrame` protected from stale audio position** — uses explicit
   `pendingVideoTargetMs` during navigation.

### Web (`frontends/app/src/state/playbackStore.ts`)
1. **Explicit unit-target (including 0)** applied on load/loadedmetadata/resume
   (`pendingVideoTargetSec`).
2. **In-scene navigation does not reload video element** — scene key
   (`currentVideoSceneKey`): same file → only `currentTime`, old frame held,
   new frame replaces directly (no black gap).
3. **`unitStartMs` based on server `start_ms`** — unified calculation with Android.

### Backend (`backend/src/video/video-merge.js`, `video-timeline.js`)
- `alignGroupClips` — align clips to exact audio frames (root cause of "unit shift"
  in concatenation);
- `forceKeyframesAtUnitBoundaries` — keyframe at each unit boundary (exact
  unit targets for `SEEK_CLOSEST`).

---

## 5. Current Stable Behavior (reference)

1. **Unit selection in Navigator:** old frame held on screen → video player
   recreated from cached scene file → exact `SEEK_CLOSEST` → unit frame
   appears directly. No image, cover, black screen, or flash. Video↔audio
   delta after seek ≈ 160–200 ms (~1 frame).
2. **Pause** — seek is exact, delta 0 (peek-render renders exactly the target frame).
3. **Layer switching:** instant, both directions; video returns already at
   audio position (both were running in real-time), no rebuild delay or desync.
4. **Speed drift** limited by speed-lock (no visible jumps).
5. **Final concatenation untouched** — single file, synchronization baked in during merge.

---

## 6. Experimental Methods (diagnostic path)

To avoid repeating this in the future, all tried approaches and their
results are documented:

1. **Various seek variants** — default `seekTo` (keyframe), `SEEK_CLOSEST`,
   re-seek on reset. Conclusion: only `SEEK_CLOSEST` gives exact mid-unit frame.
2. **Forced polling** (repositioning video based on audio every ~200 ms) —
   proved the "wrong position first, then correction" mechanism, but produced visible
   jumps → removed, replaced by speed-lock and targeted fixes.
3. **`currentTime` vs actual position analysis** — `currentPosition` in pause
   reports requested target, not rendered frame; position cannot be verified by
   position — frame capture is needed.
4. **Video player event sequence check** — `loadedmetadata/canplay/
   timeupdate/seeking/seeked` (web) and `onPrepared/onSeekComplete` (Android): showed
   that seek was sometimes dropped by `start()`.
5. **Web vs Android comparison** — on the same 5-unit scene, web behaved correctly →
   timestamp logic is correct, problem was in Android seek/surface implementation.
6. **Clean rebuild + cache/data clear** — ruling out caching as cause.
7. **Player reuse on Android (experiment, REJECTED)** — seek on live
   player in pause caused surface flicker on device; reverted to
   "rebuild + keepSurface". Web reuses element (browser smoothly changes
   `currentTime`), Android does not.
8. **Polling confirmation before fix** — temporary aggressive polling
   confirmed the cause was in the first incorrect seek, not in position.

---

## 7. Debug Tooling Documentation (what was used and how)

> Tooling was temporary, fully removed in the final commit of this phase.
> Description retained to reproduce the methodology if needed.

### Where data was written
- Backend route `POST /api/v1/debug/video-seek` (enabled by `VIDEO_SEEK_DEBUG=1`
  in docker-compose), wrote JSONL to `<OUTPUT_DIR>/logs/video_seek_debug.jsonl`;
  frames to `<OUTPUT_DIR>/logs/frames/<seek_id>.png`.
- Android sent records fire-and-forget via `Repository.postVideoSeekDebug` →
  `BackendApi.postVideoSeekDebug`.
- User has no logcat — some messages were duplicated to yellow text on
  player screen (`debugText`).

### What events were logged
| Event | Content |
|---|---|
| `SEEK_REQUEST` | `unit_id`, `unit_index`, `unit_start`, `unit_end`, `seek_target` — what the app intended to do |
| `SEEK_RESULT` | `video_after`, `video_duration`, `video_file` — where video actually landed after seek |
| `SEEK_TRACE` | 50ms samples `(v, a, playing)` for ~1.5s after seek — exact moment of position change |
| `LOCK_CHECK` | `video_pos`, `audio_pos`, `delta_ms` at +1.5s and +4s — whether position is later overwritten |
| `FRAME_CAPTURE` | base64-JPEG of actual surface frame (PixelCopy) — compared with expected clip frame (PSNR) |
| `AUDIO_SEEK_RESULT` | `audio_after` — audio axis (the only previously unmeasurable) |
| `LAYER_TOGGLE` | positions, `paused`, `playing` during layer switching |
| `VIDEO_ERROR` | `what`/`extra` of player errors (prepare/decode) |

### How analysis was performed
- **Expected vs actual position:** `seek_target` (from `unitStartMs`) vs
  `video_after` (SEEK_RESULT) and vs `v` in traces. If `unit_start` wrong —
  error before Player; `seek_target` wrong — seek calculation; `video_after` at
  previous unit position — player/surface itself.
- **Frames:** server saved PNG, ffmpeg comparison (PSNR) with reference clip frame
  at target — distinguished "wrong position" from "position correct but stale
  frame on screen".
- **Sequence:** JSONL方便 for line-by-line chronology analysis
  (tap → SEEK_REQUEST → seek → SEEK_RESULT → LOCK…).

---

## 8. Web ↔ Android Parity and Divergences (documented)

| Mechanism | Android | Web | Status |
|---|---|---|---|
| Explicit unit-target (including 0) | `explicitVideoSeekPending` → seekTo | `pendingVideoTargetSec` → currentTime | ✅ aligned |
| Seek calculation (start_ms → cumulative) | `unitStartMs()` | `unitStartMs()` | ✅ identical |
| Target application on resume | `pendingVideoTargetMs` | `pendingVideoTargetSec` | ✅ aligned |
| Re-application on ready | onPrepared | loadedmetadata / attachVideo | ✅ aligned |
| Audio-seek to unit | `seekTo(seekMs)` | `seekAudio(el, seekMs)` | ✅ aligned |
| Navigation without flash (same scene) | keepSurface: player recreated, old surface alive | element not reloaded, only currentTime | ✅ same result, different implementation |
| Layers: video doesn't die on hide | z-order `bringToFront` (surface never hidden) | `display:none` (element not touched) | ✅ conceptually aligned |
| Layers: re-enable already-enabled video | video source NOT touched (`updateLayers`-re-show, `targetScene` only for audio-only source) | re-show; seek only on drift > 0.5s (2026-08-17) | ✅ aligned (2026-08-17) |
| Exact mid-unit seek | `SEEK_CLOSEST` (Android keyframe alignment) | native precise browser seek | ✅ not applicable to web |
| Speed-lock | `setPlaybackParams` (adaptive speed correction) | none | ⚠️ divergence: no drift observed on web, implement only if needed |
| Player reuse on navigation | **rejected** (seek on live player in pause flickers on device) | always reused | ⚠️ Android platform limitation |
| Silent scene: advance after last unit | `onAudioCompleted()` in silent cycle | `onAudioCompleted()` in silent cycle | ✅ aligned (2026-08-16) |
| Silent scene: resume cycle after pause | `startSilentIuCycling` in resume | `startSilentIuCycling` in resume | ✅ aligned (2026-08-16) |
| Video show before first frame | `videoReadyToShow` (STATE_READY / onRenderedFirstFrame) | `videoHasFrame` (loadeddata) | ✅ aligned (2026-08-16) |
| Reveal gate on unit seek (n-1) | `videoSeekInFlight` + `pendingRevealPosMs = start+150ms` | `videoSeekInFlight` + `pendingVideoRevealSec = target+150ms` (timeupdate) | ✅ aligned (2026-08-17) |

**Parity audit (2026-08-16):** three Android fixes not present on web were
ported and aligned: silent scenes advance to next scene (web
was cycling images forever), silent cycling resumes after pause, and video is not
shown before first frame (no black rectangle over storyboard).

**Parity audit (2026-08-17):** single master timeline — audio. `video_start_ms`
removed from Player on both fronts (second scale could not reliably hit the first
unit frame — "first ≥ boundary" frame at LTX clip boundary turned out to be the last
frame of previous unit). Replaced with position-based reveal gate: on unit seek, element
is hidden, SELECTED unit storyboard covers the transition (audio scale), video
is revealed only when position is actually inside the unit (target + 150ms).

**Parity audit (2026-08-17, video layers):** web re-enable of video layer during running
playback unconditionally did audio-sync seek of already-attached video
(`setLayerVideo(true)` → `ensureSceneVideo` → `seekAttachedVideo` →
`applyVideoSeek(null)`), which reset buffer and entered buffer gate (6→20s) —
long/infinite buffering. Android doesn't do this: video source on
re-enable is not touched (instant re-show), rebuild only for audio-only
source (layer was disabled on scene load). Web brought to parity:
attached video on re-enable only shows (seek only on drift > 0.5s,
possible due to disabled gate with hidden layer); missing video —
previous late-video path.
Intentional divergences remain: single ExoPlayer + `MergingMediaSource`
(Android) vs `<audio>`+`<video>` pair with adaptive buffer gate (web) —
each scheme is correct for its platform (on web, client cannot merge
separate MP3/MP4); gapless −200ms transition only on web (Android
dropped it for unified clock); persistent disk-cache video only
on Android (web relies on browser HTTP cache with ETag/304); position
preservation via reload (sessionStorage/bfcache) — web only (Android lives
with VM state).

**Key platform differences:** browser `<video>` smoothly changes `currentTime` and
survives `display:none`; Android `MediaPlayer` + `SurfaceView` — hiding surface
kills the player, and seek in pause on live player produces artifacts. So web
reuses element, Android recreates player from cached scene file with
old frame held (keepSurface). Android response speed ~0.4s slower —
platform cost, visually stable.
