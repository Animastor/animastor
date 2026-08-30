# Player Audit After T6 (state machine)

Date: 2026-08-17. Code reading only + documentation; player behavior was not changed,
except for one explicit contract bug (see P0-1 — fixed in a separate patch).

Coverage:

- Web: `frontends/app/src/state/playbackStore.ts` (1939 lines) + `playbackGate.ts` (pure gate module).
- Android: `frontends/android/.../ui/PlayFragment.kt` (1845 lines) + `PlayerGate.kt`
  + `PlaybackViewModel.kt` (phase — single source for UI).
- UI entry points: `PlayPage.tsx` (consumes `videoVisible`, `currentIuBlobUrl`, `uiState`).

---

## 1. Current Architecture Overview

Two independent "engines" with the same contract (1:1 ports, divergences in docs/06 §16):

```
Web (module-level)                              Android (fragment + VM)
─────────────────────                          ─────────────────────────
playerState: PlayerStateInternal               playerState: PlayerState
  (7 states, stored,                          (sealed class, 7 states,
   changed ONLY via transition())              changed ONLY via transition())
        │                                              │
        ├─ 4 semantic flags (accessors):               ├─ same 4 flags (val getters):
        │   isPaused / videoHasFrame /                 isPaused / videoReadyToShow /
        │   videoSeekInFlight / pendingVideoRevealSec  videoSeekInFlight / pendingRevealPosMs
        │        │                                     │
uiState.phase (signal)                      PlaybackViewModel.uiState.phase (StateFlow)
  — UI phase, written independently          — written independently (preparePlayback,
  (emitScene, pausePlayback,                  pausePlayback, enterBuffering, playNext…)
  enterVideoBuffering…)                       — single source for button/status
        │
enginePaused (signal, write-only!)
        │
videoVisible (signal → PlayPage)            videoSurface.visibility (direct UI)
```

Key characteristic: **`playerState` and `uiState.phase` are written from different places and
are not automatically synchronized** — consistency is maintained by ensuring each
transition is accompanied by an appropriate phase write. Some `playerState + phase`
combinations are intentionally inconsistent (see §4).

`selectedUnit` — single source of truth for the selected unit (replacement for
`currentIuSequence`/`currentIuIndex` pair, root cause of N−1 bugs). `currentIuBlobUrl` /
`playbackViewModel.currentIuSequence` — display/session mirrors, written as outputs.

---

## 2. State Table

Requested table: `PLAYER STATE | UI PHASE | ENGINE PAUSED | VIDEO LAYER | MEANING`.
`ENGINE PAUSED` — web signal (not present on Android: the role is played by derived `isPaused`
and VM phase). `VIDEO LAYER` — `videoVisible` (web) / `videoSurface` (Android).

| playerState | uiState.phase (typical) | enginePaused (web) | VIDEO LAYER | MEANING |
|---|---|---|---|---|
| `IDLE` | IDLE / SCENE_READY | false | off | Stop/start: no scene, player released (stopAll, closeBook, onDestroyView, showMissingChunkOverlay). |
| `LOADING_SCENE` | DOWNLOADING (or PLAYING before handleChunk) | false (true during pendingLoad) | off | Scene downloading/emitted (playSceneQueue, playNext, executePendingSeek, onTrackEnd, resumePlayback without target). |
| `SHOWING_STORYBOARD` | PLAYING / SCENE_READY / PAUSED | false | off | Audio playing (or ready), video not revealed: no frame, layer off, fresh src without target, audio-only scene. **Does NOT mean "paused"** — semantic name overload (see §4). |
| `SEEKING` | PLAYING (normal) / PAUSED (pendingLoad) | false / true | off | Unit-seek: video armed with reveal gate (position gate on audio scale, clamped to selected unit), storyboard covers surface until position is inside unit. |
| `VIDEO_READY` | PAUSED / BUFFERING | true / false | on | Video revealed but stopped: pause with revealed video, buffer gate holds video visible under "Loading…". |
| `PLAYING` | PLAYING | false | on | Video revealed and playing (first frame / reveal gate / buffer exit). |
| `PAUSED` | PAUSED / BUFFERING | true | off | Paused with storyboard (video not revealed), buffer without frame. |

### SEEKING State Payload

| field | web | Android | who sets | who clears |
|---|---|---|---|---|
| `revealGateSec` / `revealGateMs` | sec (web), ms (Android) | arming: `attachVideo`, `seekAttachedVideo`, `playVideoOverlay` (web); `targetScene` same-scene and full-rebuild (Android) | exit from SEEKING: reveal, pause, buffering, stop, detach, scene-change. Nobody "clears" the field separately — gate lives inside the state. |
| `seekLanded` | **web: false always on arming, true — only via P0-1 fix (position crossing gate)** | Android: false on same-scene seek, true immediately on full-rebuild; false→true — STATE_READY watchdog (L1391) and onPositionDiscontinuity (L1461) | — | — |
| `paused` | `isPaused()` at arming time; true — pendingLoad (handleChunk L1204); false — resumePlayback (L510) | same | — | — |

SEEKING terminators (callbacks):
- web: `onVideoTimeUpdate` (position ≥ gate + frame + within unit) → `VIDEO_READY`/`PLAYING`. No other terminators (first frame intentionally doesn't reveal during gate).
- Android: `startIuCycling` (position ≥ gate) → `VIDEO_READY`/`PLAYING`.
- Interrupts (both platforms): pause (gate dropped — safe, seek already applied to element), buffer, stop, detach, new seek (re-arming), end of scene.

Stale callback after new seek: on web `timeupdate` is static (reads current
state) — repeated/stale call simply re-evaluates new gate; on Android
discontinuity/watchdog are idempotent (read current SEEKING). **The only real
source of stale callbacks — accumulated `loadedmetadata` listeners (see R2).**

---

## 3. All State Sources

### 3.1 Web — `transition()` (26 locations, including definition)

| # | Location (line) | Caller / scenario | State |
|---|---|---|---|
| 1 | L326 | `preparePlayback` — book open / restart | `SHOWING_STORYBOARD` (if selectedUnit exists) / `IDLE` |
| 2 | L385 | `refreshContent` (non-playing branch) — soft refresh | `SHOWING_STORYBOARD` / `IDLE` |
| 3 | L457 | `playSceneQueue` — Start from beginning | `LOADING_SCENE` |
| 4 | L483 | `rotationRecovery` — recovery after rotation | `SHOWING_STORYBOARD` / `IDLE` |
| 5 | L489 | `pausePlayback` — pause | `VIDEO_READY` (revealed) / `PAUSED` |
| 6 | L510 | `resumePlayback` — restart | `SEEKING{paused:false}` (if seek) / `PLAYING` / `SHOWING_STORYBOARD` |
| 7 | L579 | `pauseIfPlaying` — tab hide, silent scene (currentPlayer==null) | `PAUSED` |
| 8 | L671 | `executePendingSeek` — external unit-seek | `LOADING_SCENE` |
| 9 | L804 | `attachVideo` with `pendingVideoTargetSec≥0` — element re-attach | `SEEKING` (gate) |
| 10 | L815 | `attachVideo` without target | `PAUSED` / `SHOWING_STORYBOARD` |
| 11 | L840 | `detachVideo` — PlayPage unmount | `PAUSED` / `SHOWING_STORYBOARD` |
| 12 | L855 | `playNext` — queue end | `SHOWING_STORYBOARD` / `IDLE` |
| 13 | L879 | `playNext` — scene fetch | `LOADING_SCENE` |
| 14 | L1177 | `handleChunk` — audio-only scene (no video/layer off) | `PAUSED` / `SHOWING_STORYBOARD` |
| 15 | L1204 | `handleChunk` — pendingLoad (positioned & paused) | `SEEKING{paused:true}` / `PAUSED` |
| 16 | L1249 | `handleSilentChunk` — scene without audio (Cover) | `SHOWING_STORYBOARD` |
| 17 | L1503 | `seekAttachedVideo` — same-scene unit-seek | `SEEKING` (gate) |
| 18 | L1570 | `playVideoOverlay` — fresh src + explicit target | `SEEKING` (gate) |
| 19 | L1581 | `playVideoOverlay` — fresh src without target | `PAUSED` / `SHOWING_STORYBOARD` |
| 20 | L1633 | `onVideoFirstFrame` — first frame decoded | `VIDEO_READY` / `PLAYING` |
| 21 | L1669 | `onVideoTimeUpdate` — reveal gate (position within unit) | `VIDEO_READY` / `PLAYING` |
| 22 | L1779 | `enterVideoBuffering` — buffer gate | `VIDEO_READY` (revealed) / `PAUSED` |
| 23 | L1818 | `resumeFromBuffering` — buffer exit | `PLAYING` / `SHOWING_STORYBOARD` |
| 24 | L1836 | `stopAll` — stop | `IDLE` |

### 3.2 Web — `uiState.phase` writes

| Location | Value | Why | Matches playerState at that moment |
|---|---|---|---|
| L319-321 `preparePlayback` | SCENE_READY / IDLE | book ready, scenes loaded | SHOWING_STORYBOARD/IDLE — yes (same if on selectedUnit) |
| L371-373 `refreshContent` (playing) | SCENE_READY | soft refresh during active player | stopAll→IDLE inside, phase "erroneously" SCENE_READY until next resume — intentional |
| L379-381 `refreshContent` (not playing) | SCENE_READY / IDLE | reset after regeneration | yes (same if) |
| L482 `rotationRecovery` | SCENE_READY | screen recreated | SHOWING_STORYBOARD/IDLE — yes |
| L494 `pausePlayback` | PAUSED | pause | VIDEO_READY/PAUSED — yes (synchronous with transition) |
| L503 `resumePlayback` (refresh) | DOWNLOADING | content regenerated | stopAll→IDLE before playNext — transient |
| L527 `resumePlayback` | PLAYING | restart | PLAYING/SEEKING/SHOWING_STORYBOARD — **no**: phase PLAYING during SEEKING and SHOWING_STORYBOARD (intentional: UI "plays", video may still be hidden) |
| L539/545 errors | SCENE_READY + error | media error | stopAll→IDLE — transient |
| L686 `executePendingSeek` | DOWNLOADING | scene loading by tap | LOADING_SCENE — yes |
| L715 `closeBook` | IDLE (initial) | book close | IDLE — yes |
| L853 `playNext` end | SCENE_READY | queue empty | SHOWING_STORYBOARD/IDLE — yes |
| L878 `playNext` fetch | DOWNLOADING | scene loading | LOADING_SCENE — yes |
| L892 `playNext` error | SCENE_READY + error | fetch failed | LOADING_SCENE — transient (no stopAll!) |
| L900 `emitScene` | PLAYING | scene delivered | **LOADING_SCENE** → then handleChunk (SEEKING/SHOWING/PAUSED) — large transient gap "phase already PLAYING, player not yet touched" (intentional, see R3) |
| L1207 `handleChunk` pendingLoad | PAUSED | positioned & paused | SEEKING{paused:true}/PAUSED — yes |
| L1780 `enterVideoBuffering` | BUFFERING | video underrun | VIDEO_READY/PAUSED — yes (buffer holds player) |
| L1823 `resumeFromBuffering` | PLAYING | buffer accumulated | PLAYING/SHOWING_STORYBOARD — yes |

### 3.3 Web — `enginePaused` writes

| Location | Value | Scenario |
|---|---|---|
| L490 | true | `pausePlayback` |
| L515 | false | `resumePlayback` |
| L580 | true | `pauseIfPlaying` silent branch |
| L1205 | true | `handleChunk` pendingLoad |
| L1250 | false | `handleSilentChunk` |
| L1423 | false | `onAudioError` |
| L1851 | false | `stopAll` |

**No location in code reads `enginePaused`** (only writes; signal exported
as API mirror `fragment.isPaused`). All writes are paired with `transition()`, where
`isPaused()` gives the same value — no drift.

### 3.4 Web — semantic projections (accessors)

- `isPaused()`: `PAUSED|VIDEO_READY → true`; `SEEKING → paused`; else false.
- `videoHasFrame()`: `VIDEO_READY|PLAYING → true`.
- `videoSeekInFlight()`: `SEEKING && !seekLanded`.
- `pendingVideoRevealSec()`: `SEEKING.revealGateSec` (sec!) | −1.
- `getPlayerState()`: state name (public output).

### 3.5 Web — operational/one-shot fields

`pendingLoad`, `sceneTransitionPending`, `nextChainReady`, `needsContentRefresh`,
`needsRotationResume`, `savedPlaybackPositionMs`, `pendingSeekPositionMs`,
`isExecutingExternalSeek`, `pendingExplicitUnitTarget`, `pendingExternalUnitId`,
`pendingVideoTargetSec`, `videoEnded`, `videoBuffering` + buffer timers,
`resumeBufferTargetS`/`lastResumedAt`, `currentVideoSceneKey`, `videoSrcUrl`,
`preloadJobToken`, `sceneEpoch`, `sceneSeqCounter`/`lastProcessedSceneSequence`,
`selectedUnit`, `currentPlayer`/`nextPlayer`/`videoEl` elements.

### 3.6 Android — `transition()` (24 locations)

| Location | Scenario | State |
|---|---|---|
| L849 | `handleChunk` pendingLoad | `Paused` |
| L872 + **L884 (duplicate!)** | `handleSilentChunk` | `ShowingStoryboard` |
| L1006 | `showMissingChunkOverlay` | `Idle` |
| L1148 | `startIuCycling` reveal (position ≥ gate) | `VideoReady`/`Playing` |
| L1216 | `onTrackEnd` — scene end | `LoadingScene` |
| L1308 | `targetScene` same-scene unit-seek | `Seeking(landed=false)` |
| L1326 | `targetScene` full rebuild | `Seeking(landed=true)` (video) / `Paused` / `ShowingStoryboard` |
| L1391 | STATE_READY watchdog (seek "already landed") | `Seeking(landed=true)` |
| L1400 | STATE_READY on hidden screen | `VideoReady`/`Playing` |
| L1416 | STATE_READY first frame (not during gate) | `VideoReady`/`Playing` |
| L1425/1428 | STATE_READY buffer exit | `Playing` / `VideoReady`/`Paused` |
| L1440 | STATE_BUFFERING | `VideoReady`/`Paused` |
| L1461 | onPositionDiscontinuity (SEEK) | `Seeking(landed=true)` |
| L1480 | onRenderedFirstFrame (gen-guarded) | `VideoReady`/`Playing` |
| L1511 | onPlayerError (real error) | `Paused`/`ShowingStoryboard` |
| L1577/1589 | `revealVideoAfterReturn` (surface recreated) | `Paused`/`ShowingStoryboard` → `VideoReady`/`Playing` |
| L1617 | `pausePlayback` | `VideoReady`/`Paused` |
| L1635/1647 | `resumePlayback` (refresh / no target) | `ShowingStoryboard` / `LoadingScene` |
| L1659 | `resumePlayback` | `Seeking(paused=false)` / `Playing` / `ShowingStoryboard` |
| L1718 | `stopAll(keepSurface)` | `Seeking(landed=true)` (keepSurface+gate) / `ShowingStoryboard` / `Idle` |
| L1834 | `onDestroyView` | `Idle` |

Android VM phases (`PlaybackViewModel`): SCENE_READY/IDLE (prepare/refresh), PAUSED
(pausePlayback), BUFFERING/PLAYING (enter/exitBuffering), DOWNLOADING/PLAYING
(resumePlayback), DOWNLOADING (executePendingSeek/playNext), SCENE_READY (errors),
PLAYING (emitScene). Same family of combinations as web.

---

## 4. Issues Found

### P0-1. Web: reveal gate dead after unit-seek (deadlock) — **FIXED**

`onVideoTimeUpdate` (L1669):

```js
if (!videoSeekInFlight() || !videoEl || pendingVideoRevealSec() < 0) return;  // requires true
...
if (shouldRevealSeekVideo({ seekInFlight: videoSeekInFlight(), ... })) {      // requires false
```

- Guard requires `videoSeekInFlight()==true` (SEEKING && !seekLanded).
- AND-gate `shouldRevealSeekVideo` requires `seekInFlight==false`.
- On web **nobody flips `seekLanded` to true** (no analog of Android watchdog
  L1391 / onPositionDiscontinuity L1461 — all arming writes `seekLanded:false`).

Result: after any unit-seek that arms SEEKING (same-scene seek L1503, fresh src
with target L1570, re-attach L804), reveal **never fires** — storyboard
stays over video until exit from SEEKING (pause/buffer/stop/scene change). `onVideoFirstFrame`
also hits `videoSeekInFlight()` and stays silent.

Regression introduced in T2.2 (commit `3da6f27`): before refactoring (`7996b48`) the condition was
`currentTime >= pendingVideoRevealSec && withinUnit`, and reveal itself cleared
`videoSeekInFlight=false` (position crossing gate IS "landing"). T6 converted
flag to projection (worked), T2.2 added "not in flight" condition to AND-gate and passed
same value as in guard — deadlock.

**Fix (minimal, contract restored):** position crossing gate IS the
web landing signal (analog of Android callbacks). In `onVideoTimeUpdate` before
AND-gate check: `transition({ ...playerState, seekLanded: true })`, if
`videoEl.currentTime >= pendingVideoRevealSec()`. After this `videoSeekInFlight()`
becomes false, AND-gate "not in flight" passes, reveal fires as before.

### P1-1. Web: silent scene + tab hide — `phase=PLAYING` when `playerState=PAUSED` — **DONE**

`pauseIfPlaying` (L579) in `currentPlayer==null && selectedUnit!=null` branch did
`transition('PAUSED')` + `enginePaused=true`, but **didn't write `uiState.phase`** —
remained `PLAYING`. Button/status lied ("Playing" during actual pause; re-tap
worked — `handlePlayButton` branch `PLAYING && isPaused()` → resume).
Android parallel (`autoPauseForBackground`) always goes through `pausePlayback()` →
`PAUSED`. Platform divergence.

**How fixed:** branch unified to single `pausePlayback()` path — safe for
silent scenario (all player-touches inside are null-safe no-op, `videoHasFrame()`
false → `PAUSED`) and additionally writes `phase=PAUSED`. Only
silent-specific `cancelIuCycling()` retained (stopping image timer cycle).
State machine and reveal-gate untouched.

**Test:** `frontends/app/src/state/playbackStore.test.ts` (2 tests) — real flow
`preparePlayback → playSceneQueue → handleSilentChunk`, then
`pauseIfPlaying()`: `getPlayerState()==PAUSED`, `uiState.phase==PAUSED`,
`enginePaused==true`; second test — `resumePlayback()` after pause returns
`SHOWING_STORYBOARD` + `phase=PLAYING` + `enginePaused=false`. Test fails on
pre-fix code (phase remained `PLAYING`).

### P1-2. Web: stale `loadedmetadata` listeners (stale callbacks) — **DONE**

`playVideoOverlay` registered self-removing `onMeta` on each call and did not
remove previous ones (not on scene change, not in `detachVideo`, not in `stopAll`): old
listener fired on `loadedmetadata` of NEW scene and applied stale
`explicitSeekMs` (transient wrong seek; final state always correct —
full analysis in §8).

**How fixed (variant A, §8.4):** single module-level ref `pendingMetaListener` —
"last intent" slot. Remove previous listener before registering new one in
`playVideoOverlay` (before assigning new src), remove in `detachVideo` and `stopAll`;
self-removal + ref cleanup on fire. Token/generation not needed: single slot,
single "last intent" per element (§8.2.7).

**Test:** `frontends/app/src/state/playbackVideoListener.test.ts` (3 tests, real
flow preparePlayback→playSceneQueue→handleChunk→playVideoOverlay with fake element):
A→B leaves ONLY listener B (A removed); fired listener removes itself, and
`detachVideo` cleans slot; `stopAll` cleans slot. 2 of 3 fail on pre-fix code.

### P2-1. Web: `enginePaused` — write-only signal — **DONE**

Nobody reads in production; kept as API mirror. Candidate for removal (after
checking out-of-repo consumers) or explicit "mirror for parity" documentation.

**Usage audit (full site list, `frontends/app`):**

| Type | Location | Value | Function/context |
|---|---|---|---|
| write | `playbackStore.ts:112` | `signal(false)` | declaration + **export** (`fragment.isPaused` mirror) |
| write | `playbackStore.ts:496` | `true` | `pausePlayback()` |
| write | `playbackStore.ts:521` | `false` | `resumePlayback()` |
| write | `playbackStore.ts:1220` | `true` | `handleChunk` (pendingLoad — positioned & paused) |
| write | `playbackStore.ts:1265` | `false` | `handleSilentChunk()` |
| write | `playbackStore.ts:1438` | `false` | `onAudioError()` |
| write | `playbackStore.ts:1890` | `false` | `stopAll()` |
| read | `playbackStore.test.ts:42,61,89,103` | `enginePaused.value` | ONLY tests (P1-1 contract: pauseIfPlaying → PAUSED + phase + enginePaused; resume) |

**Production reads: 0.** Repository-wide search for `enginePaused` finds only
`playbackStore.ts` (7 writes + export), `playbackStore.test.ts` (4 reads) and this
document. `PlayPage.tsx` imports `subtitleText`, `iuMissing`, `videoVisible`,
`pendingExternalSeek` — NOT `enginePaused`. No indirect usage: no
destructuring, computed/watch, template bindings, or object/state references.

**Android:** 0 matches — `enginePaused` absent from Android code and not part of
shared contract (Android parallel — derived `isPaused` from fragment and
ViewModel phase).

**Conclusion (classification): C — only written, never read in production**
(formally exported — "external symbol", but no real consumers outside store;
only readers are P1-1 tests).

**How fixed (P2-1, removal):** signal fully removed — declaration/export
(L112) and all 7 writes (`pausePlayback`, `resumePlayback`, `handleChunk`
pendingLoad, `handleSilentChunk`, `onAudioError`, `stopAll`). Test P1-1
(`playbackStore.test.ts`) converted to check `getPlayerState()==PAUSED` +
`uiState.phase==PAUSED` (contract fully covered by these two — `enginePaused`
duplicated `isPaused()`). PlayerState / transition() / uiState.phase / reveal gate /
video lifecycle / Android untouched. Repository-wide: 0 production references
(only historical mentions in this document and test comment remain).

### P2-2. Android: duplicate `transition(ShowingStoryboard)` in `handleSilentChunk`

L872 and L884 write same state consecutively (between them only `selectedUnit`
assignment and player pause). Harmless but noisy in transition audit.

### P2-3. Web: `preparePlayback` doesn't clear `selectedUnit`/`currentIuBlobUrl` on book switch — **DONE**

When opening book B over playing A, `selectedUnit` (and blob URLs of images A)
survived `preparePlayback` → `SHOWING_STORYBOARD` with old book image on
SCENE_READY of new book; A audio continued playing. Android clears via `stopAll()`
(collector PLAYING→SCENE_READY); web had no collector equivalent.

**How fixed (root cause and reset point in §9):** in `preparePlayback`, in
existing `prevBookId !== bId` branch (before `bumpSceneEpoch`), `stopAll()` is called
(owns: selectedUnit, currentIuBlobUrl, subtitleText, iuMissing,
currentPlayer/nextPlayer, videoEl src, pendingMetaListener, videoSrcUrl,
currentVideoSceneKey, pendingVideoTargetSec, videoEnded, transition→IDLE,
updateLayers) + additional one-shot field reset for old book (NOT covered by
stopAll): `pendingLoad=false`, `pendingExternalUnitId=null`,
`needsContentRefresh=false`, `needsRotationResume=false`,
`savedPlaybackPositionMs=0`, `pendingSeekPositionMs=-1`,
`isExecutingExternalSeek=false`, `pendingExplicitUnitTarget=false`. Order is
safe: old playback cleanup → B state preparation (bookId/buildId/
sceneQueue/currentIndex/cover not touched by stopAll) → SCENE_READY → first scene B.
Same-book branch (soft re-prepare) not affected.

**Test:** `frontends/app/src/state/playbackBookSwitch.test.ts` (TEST A–D, real
flow preparePlayback→playSceneQueue→handleChunk with fake elements): A — PLAYING→B
(audio stopped, IDLE, currentIuBlobUrl null, B starts); B — PAUSED→B;
C — SEEKING→B (stale seek/gate not applied against B, audio position 0);
D — SCENE_READY of book B before first handleChunk → `currentIuBlobUrl===null`.
All 4 fail on pre-fix code.

### P2-4. Web: "overshoot" past unit end — video stays hidden — **DONE**

If between `timeupdate` events position jumped past end of selected unit,
`withinUnit=false` → reveal didn't fire, and due to one-shot landing (P0-1) +
guard `!videoSeekInFlight()` (T2.2) video stayed hidden until SEEKING exit.

**How fixed (§10.7):** in `onVideoTimeUpdate` guard replaced from
`!videoSeekInFlight()` to `playerState.name !== 'SEEKING'` — after landing every
tick re-evaluates AND-gate, and reveal fires on first tick where
`withinUnit=true`. Invariant confirmed: `SEEKING + seekLanded=true + frame ready +
gate reached + withinUnit=true ⇒ reveal` (PLAYING when playing / VIDEO_READY when
paused); when `withinUnit=false` video does NOT reveal; in PAUSED (not SEEKING) guard
blocks. State machine, gate math, seekLanded semantics, cycling — untouched.

**Test:** `frontends/app/src/state/playbackRevealOvershoot.test.ts` (5 tests,
real flow arm-SEEKING via external unit-seek): (1) overshoot doesn't reveal
and doesn't block — reveal after selectedUnit switches to next unit
(regression, fails on pre-fix code); (2) negative — when
`withinUnit=false` video doesn't reveal (multiple ticks); (3) happy path —
seek → gate → withinUnit → reveal in same tick; (4) paused-seek → `VIDEO_READY`;
(5) pause before reveal → PAUSED, new guard doesn't reveal in PAUSED.

### Semantic overloads (not bugs, but source of confusion)

- `SHOWING_STORYBOARD` ≠ "paused": it means "video not revealed". Normal combination
  `SHOWING_STORYBOARD + phase=PLAYING` for audio-only scenes and before first frame.
- `SEEKING + phase=PLAYING` — normal (audio playing, video under gate).
- `VIDEO_READY + phase=BUFFERING` — normal (revealed video under "Loading…").
- `IDLE + any phase` — transient between `stopAll()` and phase write (synchronous,
  no await, no UI gap).

### Combination that couldn't be reproduced (good news)

`playerState=PLAYING + phase=PAUSED` — doesn't occur: pause synchronously writes both
state and phase on both platforms. Similarly `PLAYING + enginePaused=true`.

---

## 5. Potential Race Conditions

- **R1 (resolved P0-1):** reveal gate deadlock.
- **R2:** accumulated `loadedmetadata` listeners (see P1-2, investigation in §8) —
  stale seek target transiently applied to new scene; final state
  always correct (proven in §8); variant A recommended (remove previous).
- **R3:** `emitScene` writes `phase=PLAYING` BEFORE `handleChunk` — window where phase is
  already PLAYING but player still in LOADING_SCENE/SEEKING. Intentional (UI "plays"
  immediately), but `handlePlayButton` in this window on tap will pause — correct.
- **R4:** `attachVideo` during unit-seek before `handleChunk` — `selectedUnit` may
  be null/stale → `unitRevealGateSec` unclamped (raw = target + tolerance).
  Rare scenario (re-attach over armed gate); harmless for long units.
- **R5:** web `stopAll()` before `executePendingSeek` resets SEEKING — harmless,
  gate re-armed from fresh target in `handleChunk`→`seekAttachedVideo`.
- **R6:** Android stale `onPositionDiscontinuity` after new seek —
  idempotent (writes `landed=true` to current SEEKING).
- **R7:** buffer during SEEKING (web: `enterVideoBuffering` requires `phase==PLAYING`,
  which is true during unit-seek) — gate dropped to `PAUSED`/`VIDEO_READY`; after
  `resumeFromBuffering` video re-syncs to audio (`diff>0.5` → `applyVideoSeek`).
  Behavior preserved relative to pre-T6.

---

## 6. Recommendations (by priority)

### P0
- **P0-1 (DONE):** web — land seek via position crossing gate in
  `onVideoTimeUpdate` (`seekLanded=true`), otherwise AND-gate never fires.
  Patch: `frontends/app/src/state/playbackStore.ts` (~5 lines) + scenario-level
  test coverage in `playbackGate.test.ts` (wiring not tested in pure module —
  coverage provided by T4 manual regression).

### P1
- **P1-1 (DONE):** web `pauseIfPlaying` silent branch — unified to single
  `pausePlayback()` path (writes `phase=PAUSED`), test in `playbackStore.test.ts`.
- **P1-2 (DONE):** `playVideoOverlay` — variant A: single module-level ref
  `pendingMetaListener`, remove previous before registering new + in
  `detachVideo`/`stopAll`. Test in `playbackVideoListener.test.ts`.

### P2
- **P2-4 (DONE):** web `onVideoTimeUpdate` — guard `playerState.name !== 'SEEKING'`
  (re-evaluation after landing; reveal on first tick with `withinUnit=true`). Test in
  `playbackRevealOvershoot.test.ts` (5 cases, regression fails before fix).
- **P2-1 (DONE):** `enginePaused` removed as write-only legacy mirror (declaration +
  7 writes); test P1-1 checks `getPlayerState()==PAUSED` + `phase==PAUSED`.
  Full write/read site list — in §4.
- **P2-2:** Android `handleSilentChunk` — remove duplicate `transition(ShowingStoryboard)`.
- **P2-3 (DONE):** web `preparePlayback` — in `prevBookId !== bId` branch `stopAll()`
  + one-shot field reset for old book. Test in
  `playbackBookSwitch.test.ts` (TEST A–D).
- **P2-5:** unify `seekLanded` semantics for fresh-src: Android arms
  `Seeking(landed=true)` immediately (L1326), web `false` (L1570). After P0-1 result is
  same, but field carries different meaning on web; align to Android variant.

---

## 7. What Was NOT Touched (intentionally)

- No large refactoring proposed: found items are targeted patches.
- Flags/fields `pendingLoad`, `sceneTransitionPending`, `nextChainReady`, `videoEnded`,
  `pendingVideoTargetSec`, generations — remain operational/one-shot per design doc;
  removal — after T4 regression.
- Full removal of `uiState.phase` in favor of `playerState` derivation — NOT recommended
  now: phase carries UI meaning (DOWNLOADING/BUFFERING/SCENE_READY) not present in
  7 states, and is written from GenerateViewModel (shared phase for entire Play screen).

---

## 8. P1-2 — Investigation: stale `loadedmetadata` listeners (web)

Investigation only; behavior code unchanged. Numbering — `playbackStore.ts` at
investigation time.

### 8.1 Actual problem

`playVideoOverlay(url, explicitSeekMs)` (L1552) on each call:

```js
videoEl.src = url;                    // L1591 — src assigned BEFORE listener registration
applyVideoSeek(explicitSeekMs);
const onMeta = () => {
  videoEl?.removeEventListener('loadedmetadata', onMeta);
  applyVideoSeek(explicitSeekMs);     // applies THIS call's value
};
videoEl.addEventListener('loadedmetadata', onMeta);   // L1599
```

Listener is self-removing but removes ONLY on fire. If `loadedmetadata`
for assigned src never arrives (load aborted by new src, element
detached, src removed via `removeAttribute`), listener stays on element
and fires on next successful `loadedmetadata` — from different scene.

### 8.2 Key lifecycle facts

1. **`src` assigned before `addEventListener` in same call** (L1591 → L1599).
   No race: `loadedmetadata` is queued task (HTML spec: media events are
   task-queued), cannot fire synchronously within current script.
2. **New `src` aborts current load** (spec: media element load algorithm —
   previous load cancelled on new src). At most **≤ 1 active load** → out-of-order
   `loadedmetadata` impossible: metadata can arrive only for last assigned src.
3. **Exactly two paths assign `src` to video element:** `playVideoOverlay` (L1591)
   and `attachVideo` (L798, re-attach after PlayPage unmount). Src removal —
   `detachVideo` (L837) and `stopAll` (L1855). `seekAttachedVideo` (unit-seek within
   scene) does NOT change src.
4. **Listener applies only `explicitSeekMs`** of its own call (closure).
   `currentVideoSceneKey`, `pendingVideoTargetSec`, `videoSrcUrl` not in closure.
   `applyVideoSeek(explicitSeekMs)` → `el.currentTime = explicitSeekMs/1000`
   (absolute position) or audio-sync when `null`.
5. **No ready generation token on web:** `sceneEpoch` reset only on resets
   (preparePlayback/playSceneQueue/executePendingSeek/refreshContent/closeBook), NOT on
   every scene change; `sceneSeqCounter` — chunk delivery counter, not tied to
   video. `videoPlayerGeneration` (Android) absent on web.
6. **`removeEventListener` is correct:** listener named (`const onMeta`),
   self-removal works. Problem not in removal mechanism, but in that it fires
   only on fire, and fire for aborted load never arrives.
7. **Multiple simultaneous `loadedmetadata` listeners not needed:** exactly one
   "last intent" per element. Single slot correct.

### 8.3 Race timeline

**Scenario 8 (A → B):** `playVideoOverlay(A, targetA)` → `onMetaA`; src A not yet
metadata → `playVideoOverlay(B, targetB)` → `onMetaB` (registered
AFTER, src A aborted) → `loadedmetadata B`:

```
dispatch loadedmetadata (single task, FIFO by registration):
  onMetaA: removes self, applyVideoSeek(targetA) → el.currentTime = targetA   ← stale
  onMetaB: removes self, applyVideoSeek(targetB) → el.currentTime = targetB   ← final ✓
```

**Final state always correct:** call order = registration order =
`playVideoOverlay` call order, and last call is current scene.
Therefore last applied is always current scene intent. Both seeks in one task —
browser typically coalesces them into one (last value wins).

**Other scenarios from inquiry:**

- **A → B → A:** `onMetaA1`, `onMetaB`, `onMetaA2` → final `targetA` (A2) ✓
  (re-assigning same URL also triggers load → metadata fires again).
- **unit A → unit B in same scene:** `seekAttachedVideo` returns true before
  `playVideoOverlay` — src unchanged, new listeners not registered, metadata
  not re-listened. Listeners don't participate here ✓.
- **detach/stopAll between calls:** `videoEl = null` → stale-fire becomes no-op
  (`applyVideoSeek` exits on `!el`, `removeEventListener` skipped — listener
  stays on old element and goes to GC with it) ✓.
- **`attachVideo` re-src** — only src assignment path WITHOUT new
  `onMeta` registration. But it re-assigns `videoSrcUrl` = current scene URL, and newest
  surviving listener encodes intent of last `playVideoOverlay` of current scene
  → correct target applied ✓.

**What actually remains (not "wrong final"):**

1. **Transient wrong seek:** `currentTime` momentarily becomes `targetA`
   (between `onMetaA` and `onMetaB`). With time-distributed seeks (if browser
   doesn't coalesce) — extra Range-fetch of scene A range and, on slow networks,
   short buffer gate entry ("Loading…"), which self-heals via monitor
   (200 ms poll → bufferedAhead → resume).
2. **Listener accumulation:** on rapid scene churn whose metadata never arrives,
   listeners accumulate, but each next successful `loadedmetadata` removes all
   (FIFO) — accumulation self-limiting and bounded by count of "aborted" scenes.
3. **Sensitivity to future changes:** any new src assignment path or
   registration reordering silently breaks "newest is last" invariant.

### 8.4 Solution

**Variant A (recommended — IMPLEMENTED):** module-level ref for last listener
(`let pendingMetaListener: (() => void) | null`), remove previous before
registering new in `playVideoOverlay` (before new src assignment) + in
`detachVideo` and `stopAll` (~4 lines, state machine and reveal-gate unaffected).
On fire `onMeta` removes self and clears ref (`if (pendingMetaListener ===
onMeta) pendingMetaListener = null`).

**Why A, not B/D:**

- **A eliminates both accumulation and transient seek completely** — old listener
  removed BEFORE new src assignment, so `loadedmetadata B` fires only `onMetaB`.
  Item 8.3.1 (only real risk) disappears entirely.
- **A closes the only "leaky" path** (`attachVideo` re-src without new
  onMeta): removal in `detachVideo` removes surviving listeners before re-attach.
- **B (token guard)** — working alternative: `onMeta` compares captured token
  with current and skips `applyVideoSeek` on staleness. Eliminates transient but
  listeners continue accumulating until fire; requires new counter (§8.2.5).
- **D (leave as-is)** — formally acceptable: proven that wrong final
  state is unreproducible (FIFO invariant + single active load). But
  transient seek remains, and invariant fragile to future edits — cheaper to
  fix now.

### 8.5 Regression test — added with fix

`frontends/app/src/state/playbackVideoListener.test.ts` (3 tests): instead of spy on
`currentTime` setter, test captures slot itself — via fake `<video>` element with
listener registry (`listenerCount('loadedmetadata')`), obtained through public
`attachVideo`, and real flow `preparePlayback → playSceneQueue → mocked fetch →
handleChunk → playVideoOverlay`:
1. `playVideoOverlay(A)` → `playVideoOverlay(B)` (scene change without A firing):
   exactly ONE listener remains (B) — ref-removal of A;
2. fired `onMeta` removes self; `detachVideo()` cleans slot;
3. `stopAll()` cleans slot.
2 of 3 fail on pre-fix code (ref-removal and stopAll cleanup are new;
self-removal on fire existed before).

---

## 9. P2-3 — Investigation: book switch and stale player state (web)

Investigation only; code unchanged.

### 9.1 Actual book switch lifecycle

Path of opening book B over playing A (web): `openBookById(B)`
(`generateStore.ts:1124`) → `emitPlaybackPrepared` → `wirePlaybackCoordination`
(`playbackStore.ts:1951`) → **`preparePlayback(B)`**.

**`closePlayerBook()` is NOT called on this path** — used only from
`generateStore.closeBook()` ("Create New Book", logout) and SettingsPage. So
`preparePlayback(B)` on book switch executes **without `stopAll()`** (stopAll called
only inside deferred-seek branch — if external tap was pending).

Android parallel: `PlaybackViewModel.preparePlayback` also does NOT call stopAll, but
fragment collector `observeState` (`PlayFragment.kt:580`) calls `stopAll()` on
PLAYING→SCENE_READY phase transition — this is what clears `selectedUnit`/`currentIuSequence`
when opening new book from PLAYING. (From PAUSED→SCENE_READY collector doesn't fire —
Android has similar latent gap; web doesn't even have PLAYING case.)

### 9.2 Field state BEFORE/AFTER `preparePlayback(B)` (web)

| Field | Before (A playing) | After preparePlayback(B) | Survived? |
|---|---|---|---|
| `selectedUnit` | A: sequence+index | **unchanged (A)** | ✅ survived |
| `currentIuBlobUrl` | A unit image URL | **unchanged (A)** | ✅ survived |
| `currentVideoSceneKey` | scene key A | unchanged (A) | ✅ |
| `videoSrcUrl` | A video URL | unchanged (A) | ✅ |
| `videoVisible` | true (if playing) | false (playerState→SHOWING_STORYBOARD, videoHasFrame=false) | ✅ reset indirectly |
| `videoHasFrame()` | true (if revealed) | false (SHOWING_STORYBOARD) | ✅ reset indirectly |
| `pendingVideoTargetSec` | A seek target | unchanged | ✅ |
| `videoEnded` | false | unchanged | ✅ |
| `playerState` | PLAYING / SEEKING / PAUSED | **SHOWING_STORYBOARD** (if stale selectedUnit) / IDLE | ✅ partially (wrong on stale selectedUnit) |
| `uiState.phase` | PLAYING / PAUSED | SCENE_READY / IDLE | ✅ reset |
| `currentPlayer` / `nextPlayer` | A audio (playing!) | **unchanged — A audio continues playing** | ✅ survived |
| `videoEl` | element with A video | unchanged (src A) | ✅ |
| `coverImage` / `previewImage` | A images | **cleared** (revoke + null) | ❌ correctly reset |
| `bookId` / `buildId` / `sceneQueue` / `currentIndex` / `currentUnitIndex` | A | **B / 0 / 0** | ❌ correctly reset |
| `missingIuPosition` / `pendingExternalSeek` | — | cleared | ❌ reset |
| one-shots: `pendingLoad`, `pendingExternalUnitId`, `needsContentRefresh`, `needsRotationResume`, `savedPlaybackPositionMs`, `pendingSeekPositionMs`, `sceneTransitionPending`, `nextChainReady`, `isExecutingExternalSeek`, `pendingExplicitUnitTarget` | values from A lifecycle | unchanged | ✅ survived |

### 9.3 A→B scenarios

- **A→B without stopAll (normal path, openBookById):** everything from 9.2 survives. A audio
  continues playing (phase=SCENE_READY but element alive), A image on screen.
- **A→B during PLAYING:** RAF cycling continues spinning A units
  (isPaused=false, selectedUnit/currentPlayer still A) — `currentIuBlobUrl` changes
  with A images; when A audio finishes, `onAudioCompleted` → `playNext` starts
  scene 0 of book B "on its own".
- **A→B during PAUSED:** A audio paused, but element and A image present;
  tap Play → SCENE_READY → `playSceneQueue` → handleChunk(B) overwrites everything.
- **A→B during SEEKING:** gate drops to SHOWING_STORYBOARD; stale
  `pendingVideoTargetSec` (A target) may be applied by `attachVideo`/`resumePlayback`
  to element with A video src before handleChunk(B) re-arms everything.
- **A→B right after unit switch:** selectedUnit/currentIuBlobUrl = new A unit
  — same leak.

### 9.4 Visual scenario (confirmed by PlayPage render)

`PlayPage.tsx:209`: `imgSrc = phase==='SCENE_READY' && previewImage ? previewImage :
currentIuBlobUrl.value` — on SCENE_READY of book B (previewImage cleared) renders
**old `currentIuBlobUrl` of book A** until first handleChunk(B). Old video frame NOT
shown (videoVisible requires VIDEO_READY/PLAYING, playerState after
preparePlayback is SHOWING_STORYBOARD), but "old A image" and "A audio playing" — yes.
Leak window: from preparePlayback(B) to handleChunk(B) (loading first scene B).

### 9.5 Semantic ownership

| FIELD | BOOK CHANGE | SCENE CHANGE | UNIT CHANGE | WHY |
|---|---|---|---|---|
| `bookId` / `buildId` / `sceneQueue` / `currentIndex` / `currentUnitIndex` | **clear/replace** | replace | keep (index changes) | book/queue ownership |
| `selectedUnit` | **clear** | replace (handleChunk) | replace (handleChunk/cycling) | selected unit belongs to book+scene |
| `currentIuBlobUrl` / `subtitleText` / `iuMissing` | **clear** | replace (showIu) | replace (showIu) | display outputs of selectedUnit |
| `coverImage` / `previewImage` | **clear** (already) | replace | keep | book art |
| `currentPlayer` / `nextPlayer` | **release/stop** | replace (gapless) | keep | audio elements |
| `videoEl` | **stop/clear src** | keep (adopted) | keep | single video element |
| `videoSrcUrl` / `currentVideoSceneKey` / `videoEnded` | **clear** | replace (playVideoOverlay) | keep | attached video identity |
| `pendingVideoTargetSec` | **clear** | replace | set (per seek) | one-shot video target |
| `playerState` | **IDLE** | LOADING_SCENE→…→SHOWING | SEEKING | state machine |
| `pendingLoad` / `pendingExternalUnitId` / `needsContentRefresh` / `needsRotationResume` / `savedPlaybackPositionMs` / `pendingSeekPositionMs` / `isExecutingExternalSeek` / `pendingExplicitUnitTarget` / `sceneTransitionPending` / `nextChainReady` | **clear** | clear/replace | set | one-shot intents |
| `missingIuPosition` / `pendingExternalSeek` | **clear** (already) | clear | set | external seek commands |

### 9.6 Conclusion and minimal recommendation

**Stale state is POSSIBLE** (confirmed): on book switch via `openBookById`
`preparePlayback(B)` does not call `stopAll()` → `selectedUnit`,
`currentIuBlobUrl`, `subtitleText`, `iuMissing`, `videoSrcUrl`, `currentVideoSceneKey`,
`pendingVideoTargetSec`, `videoEnded`, audio elements (continue playing), playerState
(SHOWING_STORYBOARD from stale selectedUnit) and all one-shot intents survive.

**Minimal patch (in `preparePlayback`, in existing
`prevBookId !== bId` branch near cover cleanup):**

```js
if (prevBookId !== bId) {
  // …existing cover/preview cleanup…
  stopAll();                                   // selectedUnit, currentIuBlobUrl, subtitleText,
                                               // iuMissing, videoSrcUrl, currentVideoSceneKey,
                                               // pendingVideoTargetSec, videoEnded, players,
                                               // transition→IDLE
  pendingLoad = false;
  pendingExternalUnitId = null;
  needsContentRefresh = false;
  needsRotationResume = false;
  savedPlaybackPositionMs = 0;
  pendingSeekPositionMs = -1;
  isExecutingExternalSeek = false;
  pendingExplicitUnitTarget = false;
}
```

After this `transition(selectedUnit ? 'SHOWING_STORYBOARD' : 'IDLE')` gives IDLE,
SCENE_READY of book B shows cover/curtains (not A image), A audio stops.
Same-book branch (soft re-prepare) not affected — position/selection preserved.

**Implemented** (fix + tests): see §4 P2-3 → DONE. Reset point — start of
`prevBookId !== bId` branch in `preparePlayback`; `stopAll()` owns engine/display/video
fields, one-shots reset separately (no duplication of what stopAll already clears).
Regression tests: `playbackBookSwitch.test.ts` (TEST A–D, fail on pre-fix code).

---

## 10. P2-4 — Investigation: "overshoot" past unit end — video stays hidden (web)

Investigation only; code unchanged.

### 10.1 Where A→B transition is determined

Transition A→B is determined in `startIuCycling` (RAF cycling on **audio**
`currentTime`): audio position maps to unit index (by server `start_ms`,
otherwise cumulative `durationMs`), and when `idx !== sel.index` —
`selectedUnit = { ...sel, index: idx }` + `showIu` + `navigateTo`. `selectedUnit`
change does NOT touch PlayerState, `currentVideoSceneKey`, `videoSrcUrl`
(video source same — scene not changed). Video reveal on unit-seek
done by `onVideoTimeUpdate` (reveal gate, audio master timeline).

### 10.2 Exact reveal gate code (current)

```js
function onVideoTimeUpdate(): void {
  if (!videoSeekInFlight() || !videoEl || pendingVideoRevealSec() < 0) return;  // GUARD
  if (videoEl.readyState < 2) return;
  const withinUnit = posMs < unitEndMs(ius, selectedUnit.index);                // overshoot → false
  if (playerState.name === 'SEEKING' && pos >= pendingVideoRevealSec()) {
    transition({ ...playerState, seekLanded: true });                          // P0-1: landing by position
  }
  if (shouldRevealSeekVideo({ seekInFlight: videoSeekInFlight(), withinUnit, ... })) {
    transition(isPaused() ? 'VIDEO_READY' : 'PLAYING');                        // reveal
  }
}
```

### 10.3 Root cause

P0-1 introduced "landing" by position: gate crossing makes `seekLanded=true`
ONCE. Guard `!videoSeekInFlight()` ( = `SEEKING && !seekLanded`) after this
permanently blocks all subsequent ticks. If in the SINGLE tick where position
first ≥ gate, `withinUnit=false` (position already past end of selected unit), then:

- flip happens (pos ≥ gate), reveal DOESN'T happen (withinUnit false);
- state remains `SEEKING{landed:true}`; video hidden (videoHasFrame=false);
- all subsequent ticks: guard `!videoSeekInFlight()` → return. **Permanent lock**
  until SEEKING exit (pause/resume/buffer/stop/new seek/scene change).

**This is a T2.2+P0-1 regression.** Before T2.2 (`7996b48`) `videoSeekInFlight` stayed true
until reveal, and each next `timeupdate` re-evaluated condition: as soon as
`selectedUnit` switched to B (or position fell inside unit),
`withinUnit` became true → reveal fired. "Overshoot" gave only DELAYED
reveal. One-shot landing (P0-1) + one-shot guard (T2.2) turned "skip
and retry" into "skip and lock".

### 10.4 Reproduction condition (exact)

Tick where simultaneously: `SEEKING && !seekLanded` (guard passed), `pos >= gate`
(→ flip), `pos >= unitEnd(selectedUnit.index at this tick)` (→ withinUnit false).
Gate = `min(target + 150ms, unitEnd − 40ms)`. Since gate ≤ unitEnd − 40, tick
can "jump over" gate already past unit end, when:

- **Short unit** (duration < timeupdate cadence ~250ms + drift): first
  tick ≥ gate already after unitEnd;
- **Video ahead of audio** (drift/seek landing desync): video pos ≥
  unitEnd, but audio pos (and `selectedUnit`) still on old unit — cycling runs on
  audio and hasn't switched to B yet;
- **Frozen selectedUnit** (isPaused: cycling exits on `if (isPaused) return`).

### 10.5 State timeline

**A→B at PLAYING (normal):** seek → SEEKING{landed:false}; pos ≥ gate in window
[gate, unitEnd) → flip + withinUnit true → reveal ✓.

**A→B at PLAYING, short unit / video ahead of audio (bug):** first tick ≥ gate
already ≥ unitEnd(A), `selectedUnit` still A → flip + withinUnit false → NO reveal;
next ticks: guard blocks → **video hidden until scene end** (even after
cycling switches `selectedUnit` to B).

**A→B at PAUSED:** pause before reveal drops gate (`pausePlayback` → PAUSED,
SEEKING not preserved) — lock impossible via this path; resume → first frame.

**At boundary (audioTime == unitEnd) and audioTime > unitEnd by few ms:**
if gate still armed and landing tick catches pos ≥ unitEnd — same lock.

### 10.6 Web vs Android

Android: reveal executed in `startIuCycling` cycle (poll ~50 ms) — each tick
independently re-evaluates `shouldRevealSeekVideo(seekInFlight, revealGateMs,
posMs, unitEndMs)`. `seekLanded` there flipped by callbacks (STATE_READY
watchdog / onPositionDiscontinuity), NOT by position, and poll has no one-shot
guard: tick with `withinUnit=false` simply skipped, next (after 50 ms,
after selectedUnit switch) fires. **Android self-recovers; lock
impossible.** `seekLanded` semantics on Android — "seek request completed by browser",
on web (after P0-1) — "position crossed gate". Guard difference is the reason:
web handler is event-based (timeupdate) and one-shot, Android cycle is persistent.

### 10.7 Minimal recommended patch — IMPLEMENTED

In `onVideoTimeUpdate` guard replaced from one-shot to "SEEKING state":

```js
// was:
if (!videoSeekInFlight() || !videoEl || pendingVideoRevealSec() < 0) return;
// now:
if (playerState.name !== 'SEEKING' || !videoEl || pendingVideoRevealSec() < 0) return;
```

Landing (P0-1) remains idempotent (`{...playerState, seekLanded:true}`),
AND-gate still requires `!seekInFlight` + `withinUnit` + `hasFrame`. Tick with
`withinUnit=false` doesn't reveal, and next tick (selectedUnit now B / position
inside unit) reveals: pre-T2.2 self-recovery restored and
Android cycle parity. **Invariant confirmed** (pre-fix check): SEEKING +
landing + frame + gate + withinUnit ⇒ reveal on next tick; when
`withinUnit=false` — no reveal; in PAUSED guard blocks (state not SEEKING).

**Regression test (implemented):** `playbackRevealOvershoot.test.ts` — see §4
P2-4 → DONE (5 cases; "overshoot → reveal after selectedUnit switch" case fails
on pre-fix code).

---

## 11. Integration Audit — post P2-4

Checkpoint after fix chain **P0-1 → P1-1 → P1-2 → P2-1 → P2-3 →
P2-4** (web; Android code unchanged in this step, participates only as contract
reference). Goal — confirm sequential fixes didn't create
new conflict in the chain
`audio position → selectedUnit → external seek → SEEKING → video seek → seekLanded
→ onVideoTimeUpdate → reveal gate → VIDEO_READY / PLAYING`.

Method: re-read current (post-all-fixes) implementations of `preparePlayback`
(P2-3), `executePendingSeek`/`checkPendingExternalSeek`, `handleChunk`,
`seekAttachedVideo`/`playVideoOverlay`/`attachVideo`/`detachVideo` (P1-2),
`pausePlayback`/`resumePlayback`/`pauseIfPlaying` (P1-1), `stopAll`,
`onVideoTimeUpdate` (P0-1+P2-4), `enterVideoBuffering`/`resumeFromBuffering`,
`setLayerVideo`, `updateLayers`, PlayPage render; Android parallel by
`PlayFragment.kt` (poll cycle startIuCycling, pause/resume, stopAll keepSurface).
Code unchanged.

### 11.1 Fix chain status

| Fix | What it closed | Status at audit time |
|---|---|---|
| P0-1 | one-shot `seekLanded` landing in `onVideoTimeUpdate` (reveal gate deadlock) | closed |
| P1-1 | `pauseIfPlaying` silent branch wrote `phase=PLAYING` when `PAUSED` | closed |
| P1-2 | single `pendingMetaListener` slot (stale loadedmetadata) | closed |
| P2-1 | removed `enginePaused` (write-only) | closed |
| P2-3 | book switch — `stopAll()` + one-shot cleanup in `preparePlayback` | closed |
| P2-4 | overshoot lock: guard `!videoSeekInFlight()` → `playerState.name !== 'SEEKING'` | closed |

### 11.2 Scenarios

Legend of expected values: `PS` — playerState, `SU` — selectedUnit, `VV` —
videoVisible, `VK` — currentVideoSceneKey, `PT` — pendingVideoTargetSec,
`SL` — seekLanded.

| # | Scenario | Expected | Actual | Verdict |
|---|---|---|---|---|
| 1 | PLAYING, A→B (Navigator) | PS=PLAYING; SU=B; VV=true; VK=same scene; PT=target/1000 (lives until resume — harmless); SL=true | handleChunk: SU=B → `seekAttachedVideo` (same scene, no re-src) → SEEKING{gateB} → tick: landing + withinUnit → PLAYING + updateLayers. showIu(B) synchronous in same task — old A image doesn't flash. | ✅ PASS |
| 2 | PAUSED, A→B | PS=VIDEO_READY (reveal in paused) or SEEKING{paused:true} until reveal; VV=true after reveal | `pendingLoad` branch preserves gate (`{...SEEKING, paused:true}`); seek completes and during pause sends timeupdate → landing + withinUnit → VIDEO_READY; on resume — same. | ✅ PASS |
| 3 | PLAYING, A→B→C fast, before metadata | final target C; stale B not applied | P1-2: before `src=C` old onMetaB removed (single slot), onMetaC registered; new src aborts B load — metadata C applies only target C. FIFO + "newest is last". | ✅ PASS |
| 4 | PLAYING, A→B→A fast | final target A | same scene: each tap re-arms SEEKING with fresh payload (transition fully replaces); between scenes — P1-2 slot. | ✅ PASS |
| 5 | SEEKING, A→B during incomplete seek | old seek doesn't affect B | `checkPendingExternalSeek` → `stopAll()` (SEEKING→IDLE, PT=-1) → new executePendingSeek arms fresh SEEKING{landed:false}. Old timeupdate re-reads CURRENT playerState (new gate); old onMeta removed (P1-2) or doesn't exist (same scene). | ✅ PASS |
| 6 | Unit-end overshoot (gate crossed after unitEnd) | no lock; reveal on first tick with withinUnit=true | P2-4: every tick re-evaluates AND-gate; landing idempotent. | ✅ PASS |
| 7 | Video OFF → seek → playback → ON | no extra seek; video syncs | layer off: handleChunk skips ensureSceneVideo (no SEEKING, SHOWING_STORYBOARD); ON mid-scene: attached → re-show (seek only when |diff|>0.5); not attached → `ensureSceneVideo(key, null)` → audio-sync, reveal on loadeddata. Invariant F preserved. | ✅ PASS |
| 8 | Video OFF during SEEKING | hidden (storyboard) until reveal; self-heal after ON | OFF: updateLayers hides, SEEKING lives (correct — unit storyboard on top). ON: attached branch, re-align to audio (diff) → timeupdate: landing + withinUnit → PLAYING. Theoretical angle "re-align to not-yet-landed audio" unreachable — audio local blob, seek instant. | ✅ PASS |
| 9 | **Pause during SEEKING → resume** | **PS=PLAYING/VIDEO_READY, VV=true** | **see §11.3 — BUG FOUND** | ❌ **FAIL (P1)** |
| 10 | Book switch during SEEKING | no state carry-over from A | P2-3: `stopAll()` (SEEKING→IDLE, A audio released, src removed, pendingMetaListener cleared) + one-shots; deferred seek from A zeroed if scenes not in B queue; stale fetch discarded by sceneEpoch. | ✅ PASS |

Summary: **9 PASS / 1 FAIL**. Additional FAIL variant (same class, different entry) —
buffer gate during SEEKING, see §11.3.2.

### 11.3 NEW PROBLEM (P1) — SEEKING not "sticky": pause or buffer gate during seek — IMPLEMENTED (sticky SEEKING)

#### 11.3.1 Exact scenario (web)

1. PLAYING, unit B by Navigator → SEEKING{landed:false, paused:false}, video
   seeked to B, storyboard B on top, VV=false (correct).
2. **Pause before landing** (pause tap / `pauseIfPlaying` on tab-hide — on slow
   network seek window = Range-fetch = hundreds of ms — realistic):
   `pausePlayback()` L515: `transition(videoHasFrame() ? 'VIDEO_READY' : 'PAUSED')`
   → `videoHasFrame()` during SEEKING = false → **PAUSED, gate payload DESTROYED**.
3. Resume: `resumePlayback()` → not SEEKING → `SHOWING_STORYBOARD`; video seeked to
   `pendingVideoTargetSec` and plays **hidden**.
4. No reveal paths remain:
   - `onVideoTimeUpdate` L1692: guard `playerState.name !== 'SEEKING'` → return
     (state is SHOWING_STORYBOARD);
   - `loadeddata` already fired for this src (same-scene seek doesn't re-assign
     src → `onVideoFirstFrame` won't come);
   - `updateLayers` not called in pause or resume;
   - buffer gate: `enterVideoBuffering` also writes PAUSED (see 11.3.2),
     `resumeFromBuffering` → SHOWING_STORYBOARD.

**Result: video permanently hidden** — audio playing, storyboards cycling units,
button/phase = PLAYING, no video. Unblock only via new unit-seek (new
SEEKING) or scene change (loadeddata). Same symptom as P2-4.

#### 11.3.2 Buffer gate during SEEKING (same class)

`enterVideoBuffering` L1836: `transition(videoHasFrame() ? 'VIDEO_READY' : 'PAUSED')`
→ during SEEKING same payload reset; `resumeFromBuffering` → SHOWING_STORYBOARD
+ play. Video hidden until next seek/scene. Entry: slow Range-fetch after
unit-seek (normal scenario on slow networks — gate exists for this).

#### 11.3.3 Web vs Android

Android has SAME transition semantics (pausePlayback: `if (videoReadyToShow)
VideoReady else Paused` — gate reset; resume → ShowingStoryboard), but
practically unreachable: ExoPlayer seek on local merged file is instant, and
reveal check lives in 50ms poll cycle startIuCycling — landing and reveal
happen before human tap/tab switch can enter
window. Web: video is 43MB progressive stream, seek = Range-fetch (hundreds of ms),
reveal — only via timeupdate (cadence ~250ms) → window is real. Platform divergence:
**semantically identical transitions, but different reachability**.

#### 11.3.4 Minimal recommended patch — IMPLEMENTED (Variant 1, sticky SEEKING)

**Root cause:** `pausePlayback` (L515) and `enterVideoBuffering` (L1836) wrote
`transition(videoHasFrame() ? 'VIDEO_READY' : 'PAUSED')` — during SEEKING
gate payload (`revealGateSec`/`seekLanded`) destroyed, resume went to
`SHOWING_STORYBOARD` with no reveal paths (timeupdate-guard blocks non-SEEKING,
`loadeddata` for same-scene seek already fired).

**Sticky SEEKING semantics:** while gate armed, pause and buffer gate do NOT exit
SEEKING — only mark pause:

```js
// pausePlayback / enterVideoBuffering (entry from SEEKING):
transition(playerState.name === 'SEEKING' ? { ...playerState, paused: true }
  : videoHasFrame() ? 'VIDEO_READY' : 'PAUSED');
// resumeFromBuffering (exit from buffer gate, entry from SEEKING):
transition(playerState.name === 'SEEKING' ? { ...playerState, paused: false }
  : videoHasFrame() ? 'PLAYING' : 'SHOWING_STORYBOARD');
```

- **Pause path:** SEEKING → SEEKING{paused:true}; resumePlayback was already sticky
  (SEEKING → SEEKING{paused:false}) — no changes needed. Completed seek
  sends timeupdate even during pause → landing + reveal (VIDEO_READY) per contract.
- **Buffering path:** SEEKING → buffer → SEEKING{paused:true} (entry) →
  SEEKING{paused:false} (exit, `resumeFromBuffering` adapted — otherwise exit
  again dropped payload to SHOWING_STORYBOARD).
- **Without new seek:** resume doesn't re-seek video already at target
  (re-apply `pendingVideoTargetSec` — no-op on equality).
- **P2-4 remains working:** guard `playerState.name !== 'SEEKING'` and AND-gate
  untouched; overshoot cases (including rewritten case 5 — now checks
  sticky contract instead of old reset) green.

**Regression tests (implemented):** `playbackStickySeeking.test.ts` — TEST A
(pause before landing → SEEKING{paused:true} → resume → reveal PLAYING), TEST B
(paused seek → resume without SHOWING_STORYBOARD; paused-reveal → VIDEO_READY),
TEST C (buffer gate during SEEKING → gate lives on entry and exit → reveal
PLAYING), TEST D (normal PAUSED unchanged, negative), TEST E (no second
seek after resume). Validation: A/C/E fail on pre-fix code; B/D —
contract guards.

Variant 2 (self-recovery in `onVideoTimeUpdate` for non-SEEKING with
`readyState >= 2`) remains belt-and-suspenders for future — not implemented.

### 11.4 Invariants

| Invariant | Verdict | Comment |
|---|---|---|
| A. PS != SEEKING ⇒ onVideoTimeUpdate doesn't do seek-reveal work | ✅ | guard L1692 works as designed — BUT it's exactly what leaves §11.3 scenario without recovery path (root cause) |
| B. SEEKING + landed + frame + gate + withinUnit ⇒ reveal on appropriate timeupdate | ✅ | P2-4, tests 28/28 |
| C. withinUnit=false doesn't reveal | ✅ | negative test P2-4 |
| D. Book switch doesn't carry old book state | ✅ | P2-3, tests 23/23 to 28/28 |
| E. Unit switch doesn't carry stale pending seek | ✅ | fresh payload each seek; P2-3 TEST C |
| F. Video toggle OFF/ON doesn't create extra seek | ✅ | re-show branch, re-align only on |diff|>0.5 |
| G. detach/stopAll — old metadata listeners don't affect | ✅ | P1-2, tests 19/19 to 28/28 |

### 11.5 New issues found

| Severity | Issue | Location | Status |
|---|---|---|---|
| **P1** | SEEKING not "sticky": `pausePlayback`/`enterVideoBuffering` during seek destroy gate payload → video permanently hidden (web; Android practically unreachable) | playbackStore L515, L1836, L1874 | **closed** — §11.3 (sticky SEEKING, tests 33/33) |
| P2 | `pendingVideoTargetSec` lives after reveal until next `resumePlayback` (extra re-seek to same position — effectively no-op) | seekAttachedVideo/playVideoOverlay | open (cosmetic) |
| P2 | Same-scene unit-tap re-fetches scene assets (fetchSceneData after clearPreloadCache in executePendingSeek) — audio/IU from Cache API, but extra roundtrip | executePendingSeek | open (perf) |

### 11.6 Finally closed (by this chain)

P0-1 (reveal deadlock), P1-1 (PAUSED+PLAYING), P1-2 (stale metadata), P2-1
(enginePaused), P2-3 (book switch), P2-4 (overshoot lock).

### 11.7 Priority recommendations

- **P1 — ✅ DONE**: sticky SEEKING (§11.3.4) — `pausePlayback`/
  `enterVideoBuffering` preserve payload (`{...SEEKING, paused:true}`),
  `resumeFromBuffering` returns to SEEKING{paused:false}; tests
  `playbackStickySeeking.test.ts` (TEST A–E); full suite 33/33;
- **P2 — ✅ DONE**: `pendingVideoTargetSec` cleanup at reveal — see §12 (tests 38/38);
- **P2**: (optional) same-scene unit-tap without full clearPreloadCache.

---

## 12. P2 — Investigation: `pendingVideoTargetSec` after successful reveal

### 12.1 Where set (3 locations + declaration)

| Location | Line | What it does |
|---|---|---|
| declaration | L187 | `let pendingVideoTargetSec = -1;` (initial = "no target") |
| `seekAttachedVideo` | L1527 | `explicitSeekMs != null ? explicitSeekMs/1000 : -1` — same-scene unit-seek |
| `playVideoOverlay` | L1597 | same formula — fresh-src unit-seek / rotation-resume |
| `stopAll` | L1924 | reset to `-1` (full stop) |

### 12.2 Where read (2 locations)

| Location | Line | What it does |
|---|---|---|
| `resumePlayback` | L551–553 | if `>= 0`: `videoEl.currentTime = target`, then **consumes** (`= -1`) |
| `attachVideo` | L831–842 | if `>= 0`: `el.currentTime = target` + re-arm SEEKING with gate from target (L842) |

Nowhere else read — including `onVideoTimeUpdate` (reveal) and
`onVideoFirstFrame`: after SEEKING armed, reveal logic lives only on payload
(`revealGateSec`/`seekLanded`), target itself not needed.

### 12.3 What happens at moment of successful reveal

`onVideoTimeUpdate` (L1735–1740): `shouldRevealSeekVideo(...)` →
`transition(isPaused() ? 'VIDEO_READY' : 'PLAYING'); updateLayers();` —
**target NOT reset**. Reveal requires `pos ≥ gate`, gate = target +
tolerance (clamped to unitEnd) ⇒ at reveal moment video already beyond target —
position reached.

### 12.4 Needed after reveal — NO (stale state)

- **`resumePlayback`**: applies target to video to pre-seek it to
  not-yet-reached position (audio right-after-seek may be 0). After
  reveal video already positioned inside unit and may have moved FORWARD → re-apply
  stale target = **real seek BACK to unit start** (fragment repeat),
  not no-op (clarification to §12.4). Consumption only on next
  resume — between reveal and it target hangs `>= 0` as stale.
- **`attachVideo`** (unmount/remount PlayPage after reveal): target `>= 0` →
  re-positioning + **re-arm SEEKING{landed:false}** (L842)
  → extra gate cycle (timeupdate will land and reveal again). Not a bug (self-heal),
  but extra work + repeated hidden-video interval.
- Reveal logic doesn't use target (gate is in payload). No other readers.

### 12.5 Sticky scenario (SEEKING → pause → resume → reveal)

- pause (sticky): target untouched — lives. This IS NEEDED: if seek hasn't
  landed yet, `resumePlayback` applies target (real work — pre-seek
  video to target unit, not no-op).
- resume: `resumePlayback` itself consumes target (L553 → `-1`) BEFORE reveal.
  ⇒ cleanup at reveal won't touch this scenario (target already `-1`).

### 12.6 Conclusion and recommended cleanup point — IMPLEMENTED

**Stale after successful reveal confirmed** (direct PLAYING mode: seek →
reveal without resume between; in sticky scenario target already consumed by resume before
reveal). Cleanup added to single successful reveal location —
`onVideoTimeUpdate`, inside reveal branch (one line):

```js
if (shouldRevealSeekVideo({ ... })) {
  // REVEAL — SEEKING → VIDEO_READY / PLAYING (position inside the unit).
  pendingVideoTargetSec = -1; // P2: target reached — no longer needed
  transition(isPaused() ? 'VIDEO_READY' : 'PLAYING');
  updateLayers();
}
```

Effect: `resumePlayback` after reveal skips stale re-apply (no seek back
to unit start), `attachVideo` after reveal goes to else branch (sync to audio —
audio already at target, correct) and doesn't re-arm SEEKING unnecessarily.
State machine, gate, sticky semantics, seek logic unchanged. Added
read-only accessor `getPendingVideoTargetSec()` (for tests/UI).

**Regression tests (implemented):** `playbackTargetCleanup.test.ts` — TEST A
(direct seek → reveal → target -1), TEST B (seek → pause → resume → reveal:
target lives until resume consumption, -1 after reveal), TEST C (attachVideo after
reveal doesn't re-arm SEEKING), TEST D (resumePlayback after reveal doesn't
re-seek video back — position preserved), plus "normal playback
without seek — target never armed" case. Validation: A/C/D fail without
cleanup line; B and plain — contract guards.

---

## Post-fix Integration Audit

Final checkpoint after entire series:

| Fix | What it closed |
|---|---|
| P0-1 | reveal gate deadlock (one-shot `seekLanded` landing) |
| P1-1 | `pauseIfPlaying` silent branch: `PAUSED + phase=PLAYING` |
| P1-2 | stale `loadedmetadata` listeners (single slot) |
| P2-1 | removed `enginePaused` (write-only) |
| P2-3 | book switch: stale player state (stopAll + one-shots) |
| P2-4 | overshoot lock: guard `!videoSeekInFlight()` → `!= SEEKING` |
| P1 (sticky) | pause/buffer gate during seek destroyed SEEKING payload |
| P2 (target) | `pendingVideoTargetSec` stale after reveal |

Method: 12 scenarios verified against current code (after §11 only
sticky transitions and reveal-cleanup changed — `git diff fd1d08f..HEAD` by store: 3
transitions + 1 line + accessor; other paths — scenarios 1–3, 6–10 §11
remain valid as-is). Code unchanged.

### Result: 12/12 PASS

| # | Scenario | Verdict | Key states / note |
|---|---|---|---|
| 1 | Unit A → B | ✅ PASS | PLAYING/VIDEO_READY, SU=B, VV=true; showIu(B) in same task — no stale image |
| 2 | A → B → C fast (before metadata) | ✅ PASS | final target C; P1-2 slot: onMetaB removed before src=C |
| 3 | A → B → A fast | ✅ PASS | each tap re-arms fresh SEEKING; P1-2 between scenes |
| 4 | SEEKING → PAUSE → RESUME → REVEAL | ✅ PASS | sticky: SEEKING{paused:true} → SEEKING{paused:false} → reveal; target consumed by resume |
| 5 | SEEKING → BUFFERING → RESUME → REVEAL | ✅ PASS | sticky on buffer gate entry and exit; no SHOWING_STORYBOARD |
| 6 | SEEKING → overshoot unitEnd → next unit → REVEAL | ✅ PASS | P2-4: every tick re-evaluates gate; no lock |
| 7 | Book A → B during SEEKING | ✅ PASS | P2-3: stopAll → IDLE; deferred seek from A zeroed if not in B queue |
| 8 | Video OFF → ON during playback | ✅ PASS | re-show (seek only when |diff|>0.5); no new seek |
| 9 | Video OFF → ON during SEEKING | ✅ PASS | gate lives hidden; ON: re-align → timeupdate to gate → reveal (paused variant — after resume) |
| 10 | detachVideo → attachVideo after reveal | ✅ PASS | target=-1 → else branch (sync to audio, no SEEKING); reveal on loadeddata of new src |
| 11 | resumePlayback after reveal | ✅ PASS | target=-1 → L551 branch skipped; position preserved (TEST D) |
| 12 | Pause/resume after completed reveal | ✅ PASS | PLAYING ↔ VIDEO_READY, no seek; target already -1 |

### Invariants — PASS

**After successful reveal:** `pendingVideoTargetSec == -1` (cleanup),
`playerState != SEEKING` (VIDEO_READY/PLAYING), resume doesn't start old seek
(target -1), attachVideo doesn't re-arm SEEKING (else branch), video stays
visible (videoHasFrame = true; pause/resume preserve).

**While SEEKING incomplete:** pause/buffering preserve payload (sticky),
resume continues existing seek (SEEKING{paused:false}, pre-seek target
only if still alive), new unnecessary seek not created (TEST E).

### Web vs Android

| Axis | Web | Android | Parity |
|---|---|---|---|
| pause during seek | sticky: SEEKING{paused:true} | `Paused` (payload reset) | ⚠️ **divergence** — see below |
| buffering during seek | sticky via buffer gate | N/A (local merged source, no gate) | ✅ |
| reveal | timeupdate + AND-gate (readyState≥2) | 50ms poll startIuCycling + STATE_READY | ✅ equivalent |
| unit boundary | audio master scale (start_ms / cumulative) | same scale | ✅ |

**Divergence (intentional):** Web after P1-fix holds SEEKING through pause,
Android drops to `Paused`. On Android practically unreachable (instant
local seek + 50ms poll reveal before human tap), so
Android left unchanged. If full parity ever desired —
same sticky transition in Android `pausePlayback()`.

### Closed by entire series

P0-1, P1-1, P1-2, P2-1, P2-3, P2-4, P1 sticky SEEKING, P2 target cleanup — all
audit issues closed. Tests: vitest **38/38** (gate 14, P1-1 2, listener 3,
book-switch 4, overshoot 5, sticky 5, target-cleanup 5), `tsc --noEmit` clean.

### Remaining risks (not bugs)

1. **P2 (perf)**: same-scene unit-tap re-fetches scene assets
   (fetchSceneData after clearPreloadCache in executePendingSeek) — audio/IU from
   Cache API, but extra roundtrip.
2. **Sticky Web/Android divergence** (see above) — intentional, Android
   practically unreachable.
3. **Theoretical angle in scenario 9**: re-align to not-yet-landed audio when
   Video ON during SEEKING — unreachable (audio local blob, seek
   instant).
4. **T4 (manual regression)** from main TODO never executed on
   device/in browser — integration scenarios 1–12 covered by unit tests
   at state machine level, but not by real browser timings.

### What can be considered stable

- Chain `seek → SEEKING → gate → reveal → VIDEO_READY/PLAYING` — all entry/exit paths
  (reveal, sticky pause/resume, buffer gate, overshoot, book
  switch, layer toggles, detach/attach) are consistent and covered by tests.
- After reveal no stale state: target cleared, SEEKING not re-armed
  repeatedly, video position not re-seeked backward.
- Single user flow (PLAYING) with storyboards, subtitles and
  unit switching not touched by fixes — works as before series.
