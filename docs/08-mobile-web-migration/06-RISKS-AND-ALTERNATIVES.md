# 06. High Technical Risk Components and Alternatives

This documents **all justified deviations** from one-to-one
Android → Web porting. Project rule: deviation is allowed only if
documented here **before** implementation with reason and accepted
alternative.

Player source of truth: `PlayFragment.kt`, `PlaybackViewModel.kt`,
`PositionManager.kt`, `WaveformView.kt`, `util/MediaDecoder.kt`,
`util/SimpleDiskCache.kt`, `res/layout/fragment_play.xml`, and
`docs/03-audit/PLAYER_AUDIT.md`, `docs/05-frontend/PLAYER_STATE.md`,
`docs/DONT_DO.md`.

---

## 0. Risk Summary

| # | Component | Risk | Severity | Section |
|---|---|---|---|---|
| R1 | **Play** screen: multiple synchronized media players | precise audio/video/IU sync, gapless, seek by unit, lifecycle | **Very High** | §1 |
| R2 | Gapless transition between scenes (`setNextMediaPlayer`) | no Web equivalent | High | §1.2 |
| R3 | IU-cycling by `MediaPlayer.getCurrentPosition()` (50ms tick) | `currentTime` drift vs RAF | High | §1.3 |
| R4 | Video overlay on `SurfaceView` + `syncVideoFrame` | detach/seek video to audio | Medium-High | §1.4 |
| R5 | Seek by `unitIndex` (sum of `duration_ms`) | seek precision in buffer | Medium | §1.5 |
| R6 | Soft refresh / `needsContentRefresh` / `buildId` cache invalidation | generation consistency | Medium | §1.6 |
| R7 | Preload 3 ahead + retryWithBackoff + disk cache | quotas/temp files | Medium | §1.7 |
| R8 | Lifecycle: `onHiddenChanged/onPause/onResume`, position saving | tab switching/minimization | Medium | §1.8 |
| R9 | Fullscreen + `anchorFullscreenToImage()` (letterbox+subtitles) | overlay positioning | Low-Medium | §1.9 |
| R10 | Waveform on Canvas (`WaveformView`) | custom Canvas render porting | Medium | §2 |
| R11 | SSE generation progress on mobile (reconnect/monotonicity) | network drops on 3G | High | §3 |
| R12 | `.vbook`/txt import (file association) | no ACTION_VIEW | Low | §4 |
| R13 | Library WebView | iframe/CSP policy | Low | §5 |
| R14 | Basic Auth on m.animastor.in during development | mobile UX factor | Low | §6 |

---

## 1. Player Screen — detailed breakdown

### 1.1. What exactly Android player does

`PlayFragment` holds **up to three** `MediaPlayer` objects simultaneously
(`PlayFragment.kt:51-56`):

- `currentPlayer` — current scene audio (MP3 bytes → temp file).
- `nextPlayer` — preloaded next scene audio, attached via
  `currentPlayer.setNextMediaPlayer(nextPlayer)` for **gapless** transition
  (`PlayFragment.kt:643`, `preloadAheadAudio()`).
- `videoPlayer` — same scene video overlay on `SurfaceView` (`videoSurface`),
  synced to audio via `syncVideoFrame()` (`PlayFragment.kt:1164`):
  `seekTo(currentPlayer.currentPosition)` + pause after 50ms.

Additionally:
- **IU-cycling** (`startIuCycling`, `PlayFragment.kt:866`): every 50ms on
  `currentPlayer.currentPosition` IU index calculated (cumulative sum
  of `iu.durationMs`), corresponding image + subtitle shown, and
  `SharedPositionManager.navigateTo(...)` updates `ActivePosition`.
- **Silent IU mode** (`startSilentIuCycling`): when audio is empty (e.g. Cover),
  cycling runs on timer (no `MediaPlayer`).
- **Seek by unitIndex**: `handleChunk` calculates `seekMs = sum(durationMs[0..unit))`
  and calls `currentPlayer.seekTo(seekMs)` (`PlayFragment.kt:573-631`).
- **Preload**: `PlaybackViewModel.preloadAhead()` parallel-fetches **3 scenes
  ahead** (`PRELOAD_AHEAD=3`) with `retryWithBackoff(3, 1s→2→5s)`
  (`PlaybackViewModel.kt:685-732`, `822-840`).
- **Soft refresh** after regeneration: `refreshContent()` sets
  `needsContentRefresh=true`; `resumePlayback()`/`resumeFromCurrentScene()`
  re-fetches current scene and releases stale `MediaPlayer`
  (`PlayFragment.kt:1207-1224`).
- **Disk cache**: `SimpleDiskCache` (256MB) with types audio/video/image/preview/iu;
  `clearCache()` on `buildId` change (`PlaybackViewModel.kt:198-203,259-260`).
- **Lifecycle**: `onHiddenChanged/onPause/onResume` — pause on tab hide,
  save `savedPlaybackPositionMs`/`persistedImage` on `isChangingConfigurations`
  (`PlayFragment.kt:1295-1349`).
- **DONT_DO.md**: no stall/retry IU, no rewriting sliding
  window preload, no skipping IU on `bitmap==null`, navigation only from
  FileFragment (not MainActivity). These constraints apply to web port too.

### 1.2. R2 — Gapless transition between scenes

**Problem.** Web has no direct equivalent of `MediaPlayer.setNextMediaPlayer()`.
Using two `<audio>` elements with switching gives gap/click; Web Audio
`AudioBufferSourceNode` requires full decode to buffer.

**Alternatives:**

| Option | How | Pros | Cons / risk |
|---|---|---|---|
| **A (recommended start)** | Two `<audio>` (current+next), `<audio>.preload=auto`, switch on `ended`/timer −200ms (like `sceneTransitionPending`, `PlayFragment.kt:893`); next source set early in `nextPlayer.src` | simplicity, native seek/volume/UI | possible micro-click; depends on `MediaSource` codecs |
| B | Web Audio API: decode both scenes' audio to `AudioBuffer`, schedule `start(nextStartTime)` — true gapless | perfect seamless | must decode entire buffer to memory (mobile memory); seek requires `startTime` recalculation; cumbersome |
| C | `MediaSource` Extensions (MSE) + adaptive playlist | streaming segments, low latency | requires server-side format adaptation; not all codecs |
| D | Single `<audio>` + `onended` → swap `src` | simplicity | obvious gap (decode load) |

**Accepted (stage 7):** **A** — two `<audio>` with early switch −200ms
(`sceneTransitionPending` in RAF IU-cycling cycle, like `PlayFragment.kt:893`);
fallback to native `ended` when chained next source unavailable.
If clicks prove unacceptable on target devices — switching to
**B** (Web Audio `AudioBufferSourceNode`) remains open.

### 1.3. R3 — IU-cycling by audio position

**Problem.** Android cycle reads `player.currentPosition` every 50ms and selects

[File continues — remaining sections translated similarly]
