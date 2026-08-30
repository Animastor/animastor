# Player State Machine — Design (T6)

> **Status:** 🔧 Implemented (T6). Source: `docs/03-audit/PLAYER_AUDIO_MASTER_TIMELINE.md` §4.
> Rule: **do not add new independent Player flags before this refactor.**

## Problem

Many independent flags accumulated instead of a single source of truth:

```
videoReadyToShow, videoSeekInFlight, pendingRevealPosMs, pendingRevealGen,
videoPlayerGeneration, videoCurrentGen, videoSurfaceAlive,
currentPlayerVideoVersion, currentPlayerHasVideo, currentPlayerSceneKey,
currentIuSequence, currentIuIndex, advancePending, pendingLoad, ...
```

`PlayFragment.kt:85-140` (and mirrored `playbackStore.ts`). This code produced N−1
(chain `currentIuSequence → stopAll → null → SCENE_READY → different image`).

## Target model

One `selectedUnit` = source of truth. States:

```
IDLE / LOADING_SCENE / SHOWING_STORYBOARD / SEEKING / VIDEO_READY / PLAYING / PAUSED
```

| State | Meaning | Entry | Exit |
|---|---|---|---|
| `IDLE` | No scene, player is free | init / stopAll / error | LOADING_SCENE |
| `LOADING_SCENE` | Downloading/preparing scene (audio+video+storyboard) | IDLE, seek to another scene | SHOWING_STORYBOARD / SEEKING |
| `SHOWING_STORYBOARD` | Scene ready, surface has storyboard for selected unit | LOADING_SCENE | SEEKING / PLAYING |
| `SEEKING` | Unit seek in progress; reveal gate active | SHOWING_STORYBOARD, unit tap | VIDEO_READY / PLAYING |
| `VIDEO_READY` | Position within unit, video revealed (positioned pause) | SEEKING | PLAYING / PAUSED |
| `PLAYING` | Audio master timeline playing | VIDEO_READY, resume | PAUSED / SEEKING / IDLE |
| `PAUSED` | Positioned pause | PLAYING / VIDEO_READY | PLAYING / SEEKING |

## Transition table (event → state)

Both platforms: state is **stored** (Android: private `playerState` field +
`transition()`; Web: `playerState` + `transition()`, `getPlayerState()` returns name).
Four semantic flags (`isPaused`, `videoReadyToShow`/`videoHasFrame`,
`videoSeekInFlight`, `pendingRevealPosMs`/`pendingVideoRevealSec`) collapsed into
state as read-only accessors; each flag write became a `transition()` call.
`SEEKING` carries payload: `revealGateMs` (audio timeline gate), `seekLanded`
(old videoSeekInFlight), `paused` (old isPaused). `BUFFERING` is not a state,
but "player held by buffer gate" → gate transitions express it as `PAUSED`/
`VIDEO_READY`.

| Event | Trigger (Android) | Trigger (Web) | Transition |
|---|---|---|---|
| `SCENE_LOADING` | playSceneQueue / executePendingSeek / playNext / resumeFromCurrentScene → phase DOWNLOADING | playSceneQueue / executePendingSeek / playNext / resumeFromCurrentScene | → `LOADING_SCENE` (selectedUnit == null) |
| `SCENE_TARGETED` | handleChunk / handleSilentChunk (selected unit storyboard on surface) | handleChunk / handleSilentChunk | → `SHOWING_STORYBOARD` |
| `SEEK_START` | targetScene: sameScene instant-seek; full rebuild with video (reveal gate armed) | seekAttachedVideo / playVideoOverlay / attachVideo (unit target) | → `SEEKING` (gate `pendingRevealPosMs` / `pendingVideoRevealSec` ≥ 0, video not revealed) |
| `REVEAL` | startIuCycling (pos ≥ gate, pos < unitEnd) / STATE_READY without gate / onRenderedFirstFrame / revealVideoAfterReturn | onVideoTimeUpdate (currentTime ≥ gate, within unit, readyState ≥ 2) / onVideoFirstFrame (no seek) | `SEEKING` → `VIDEO_READY` (paused) / `PLAYING` |
| `PAUSE` | pausePlayback / pendingLoad positioned-pause / STATE_BUFFERING | pausePlayback / handlePlayButton(BUFFERING) / enterVideoBuffering | → `PAUSED` (storyboard) / `VIDEO_READY` (video revealed) |
| `PLAY` | resumePlayback / exitBuffering / playButton | resumePlayback / resumeFromBuffering | → `PLAYING` |
| `ENDED` | STATE_ENDED / iuCycling watchdog / end of silent scene | onTrackEnd / switchToNextPlayer / end of silent scene | → `LOADING_SCENE` (next scene) / `IDLE` (queue empty) |
| `ERROR` | onPlayerError (fallback to storyboard) | onVideoError / onAudioError / handlePlaybackError | → `SHOWING_STORYBOARD` |
| `STOP` | stopAll / closeBook / onDestroyView | stopAll / closeBook | → `IDLE` |

## Invariant (from §5)

At any moment `selectedUnit` is the index of an object identified by `unitId` from
`resolveUnitIndexForSequence` (unitId-first). The invariant is checked after every
transition (seek, pause, resume, rotation, scene transition, Navigator).

## Flag → state mapping (refactor plan)

| Current flag | Target location | Status |
|---|---|---|
| `currentIuSequence` + `currentIuIndex` | `selectedUnit` (single source of truth) | ✅ Done (both platforms) |
| `pendingRevealPosMs` + `videoSeekInFlight` | `SEEKING` state (payload `revealGateMs` + `seekLanded`) | ✅ Done — accessors, writes → `transition()` |
| `videoReadyToShow` / `videoHasFrame` | `VIDEO_READY` | ✅ Done — accessor from state |
| `isPaused` | `PAUSED` / `VIDEO_READY` / `SEEKING.paused` | ✅ Done — accessor from state |
| `currentPlayerSceneKey` | `selectedUnit.sceneKey` property | ⚪ Remains as player field (media item identity) |
| `advancePending` | Guard for PLAYING → LOADING_SCENE transition (idempotent) | ✅ Remains as guard field (not a state) |
| `pendingLoad` | State property (positioned & paused) | ✅ Remains as one-shot field (like `pendingExternalSeek`) |
| `videoPlayerGeneration`/`videoCurrentGen`/`pendingRevealGen` | remain (guard against events from released players) | ✅ Remain as-is |
| `videoSurfaceAlive` (Android) / `videoEnded`, `sceneTransitionPending`, `nextChainReady` (Web) | surface/chain properties, not Player state | ✅ Remain as-is |

## Future rule

Do not add new independent flags. Any new behavior is expressed via:
1. state transition, OR
2. property of an existing state.

## Implementation status (T6)

- [x] Transition table (event → state) for both platforms — see above.
- [x] `selectedUnit` — single source of truth: Android `SelectedUnit(sequence, index)`
  (data class, `PlayFragment.kt`), Web `SelectedUnit` (interface + module-level variable,
  `playbackStore.ts`). The `currentIuSequence`/`currentIuIndex` pair has been removed;
  `playbackViewModel.currentIuSequence`/`currentUnitIndex` remain only as session
  restore mirrors (output, not source).
- [x] 7 states in code: Android — stored `playerState` field + `transition()`;
  Web — `playerState: PlayerStateInternal` + `transition()`, `getPlayerState()`
  returns state name. Instead of `MutableStateFlow`/`signal` — stored field
  + single transition function: state cannot diverge from accessors, and
  reactive flow is added when a consumer appears (UI drives from `uiState.phase`).
- [x] Semantic flags removed: `isPaused`, `videoReadyToShow`/`videoHasFrame`,
  `videoSeekInFlight`, `pendingRevealPosMs`/`pendingVideoRevealSec` became read-only
  state accessors; all writes replaced with `transition()`. `SEEKING` carries
  payload (`revealGateMs` / `seekLanded` / `paused`).
- [x] Guard/one-shot fields intentionally remain as fields: `advancePending` (guard
  ENDED → LOADING_SCENE), `pendingLoad` (one-shot intent positioned & paused),
  `pendingRevealGen` + generations (guard against stale players), `videoSurfaceAlive` /
  `videoEnded` / `sceneTransitionPending` / `nextChainReady` (surface/chain).
  Further consolidation — when a real state consumer appears.
