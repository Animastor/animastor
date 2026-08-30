# Android/Web Player Parity Audit

Status: 📝 Audit (code NOT changed).
Date: after web fix series P0-1/P1-1/P1-2/P2-1/P2-3/P2-4/P1-sticky/P2-target.
Method: semantics comparison against current code on both platforms
(`playbackStore.ts` / `PlayFragment.kt` + `PlaybackViewModel.kt`), plus cross-check with
older Android commits 83f7d1a (unit-switch reveal during pause), 58680f2
(AND-frame gate T2.1/T3.1/T5), d52dc2d (unit-bounded gate), 413a841 (unified
audio scale). Architectural difference is NOT considered a bug — observed
contract matters.

Architectures:
- **Web:** `playbackStore` / `PlayerState` / `transition()` / `timeupdate` /
  `loadedmetadata` / buffer gate on `waiting`.
- **Android:** `PlayFragment` / `PlaybackViewModel` / single ExoPlayer
  (MergingMediaSource: audio+video on single scale — cannot desync) /
  `STATE_READY`/`STATE_BUFFERING` / 50ms poll `startIuCycling` / generation
  guards (`videoPlayerGeneration`, `videoCurrentGen`, `pendingRevealGen`).

---

## 1. Scenarios

| # | SCENARIO | WEB BEHAVIOR | ANDROID BEHAVIOR | EQUIV? | ARCHITECTURAL DIFFERENCE | REAL RISK? |
|---|---|---|---|---|---|---|
| 1 | Unit A → B during PLAYING | seekToPosition → checkPendingExternalSeek → stopAll → executePendingSeek → handleChunk: selectedUnit=B, showIu(B), seekAttachedVideo → SEEKING{landed:false, paused:true} (pendingLoad), phase PAUSED → Play → reveal via gate | Navigator tap → pendingExternalSeek → stopAll(keepSurface=true) (preserves scene+gate) → handleChunk: selectedUnit=B, showIuImage(B) → pendingLoad: Paused → targetScene sameScene: seekTo(startPosMs) + Seeking{landed:false, paused:true} → Play → poll reveal via gate | **YES** | Web: stopAll→IDLE + re-arm SEEKING{landed:false} in seekAttachedVideo. Android: keepSurface-stopAll preserves gate {landed:true}, targetScene re-arms {landed:false}. Both require Play after tap (positioned-paused) | no |
| 2 | Unit A → B during PAUSED | positioned-paused: SEEKING{paused:true} → reveal in paused (timeupdate from completed seek) → VIDEO_READY | positioned-paused: Seeking{paused:true} → poll check reveal BEFORE isPaused-gate → VideoReady (commit 83f7d1a) | **YES** | Web: reveal via timeupdate (fires on seek during pause). Android: 50ms poll independent of pause | no |
| 3 | SEEKING → PAUSE → RESUME → REVEAL | **sticky**: pausePlayback → SEEKING{paused:true} (payload alive) → resume → SEEKING{paused:false} → reveal via gate | pausePlayback → `Paused` (payload reset) → resume → `ShowingStoryboard`; fallback path: STATE_READY (`currentPlayerHasVideo && !Seeking` → Playing/VideoReady) | **NO** (observationally equivalent in reachable cases) | Web sticky — P1 fix. Android NOT sticky in pausePlayback; seek local/instant + 50ms poll reveals before human tap; during buffering READY-reveal saves | low (theoretical lock — only machine tap/auto-pause in seek window on slow network, see §3) |
| 4 | SEEKING → BUFFERING → RESUME → REVEAL | sticky on buffer gate entry/exit: SEEKING{paused:true} → SEEKING{paused:false} → reveal via gate (target+tolerance) | STATE_BUFFERING → `transition(Paused)` (gate reset) + enterBuffering; STATE_READY → `!Seeking` → Playing/VideoReady + exitBuffering — reveal on **frame ready** at seek target | **YES** | Android doesn't store gate during buffer gate, but READY-reveal for non-SEEKING is a fallback path web didn't have (hence web needed sticky). Frame on Android may reveal slightly earlier (at target, not target+tolerance) — that's unit B start, not A tail | low (only first frame precision, P2) |
| 5 | SEEKING → overshoot unitEnd → next unit → REVEAL | P2-4: every tick re-evaluates AND-gate; overshoot tick doesn't reveal, reveal when withinUnit=true | 50ms poll + `pos < unitEndMs` (belt-and-suspenders) in shouldRevealSeekVideo — never had one-shot guard, lock impossible | **YES** | Web fixed what Android never had (poll without one-shot flip) | no |
| 6 | Book A → Book B during PLAYING | P2-3: preparePlayback prevBookId≠bId → stopAll() + one-shots; stale image/audio don't survive | MainActivity: fragment.stopAll() (→Idle, all fields clean) + VM.preparePlayback; additionally observeState PLAYING→SCENE_READY → stopAll(); deferred seek from A dropped if not in B queue | **YES** | Web: stopAll inside preparePlayback. Android: stopAll in coordinator/collector + preparePlayback | no |
| 7 | Book A → Book B during SEEKING | P2-3: stopAll → IDLE (gate reset); stale seek not applied against B | fragment.stopAll() → Idle (gate reset); VM.preparePlayback: pendingExternalSeek dropped if not in new queue | **YES** | same coordinator/collector split | no |
| 8a | Video OFF → ON during PLAYING | OFF: updateLayers (hidden, audio+storyboards continue). ON: attached → re-show (re-align only when |diff|>0.5); not attached → ensureSceneVideo(key,null) audio-sync | OFF: updateLayers (over storyboard, surface alive). ON: source already has video → just updateLayers (re-show); audio-only → targetScene(af, currentPosition, includeVideo=true) — rebuild at **current audio position** | **YES** | Web: display:none element + diff re-align. Android: single merged source physically doesn't drift — rebuild at same position | no |
| 8b | Video OFF → ON during SEEKING | gate lives hidden; ON: re-align → timeupdate to gate → reveal (paused — after resume) | OFF: updateLayers hides, SEEKING untouched. ON: source with video → re-show (reveal via gate in poll); audio-only → targetScene(cur) → fresh Seeking{landed:true} → reveal via gate | **YES** | same re-show/rebuild pair | no (theoretical angle re-align to not-yet-landed audio unreachable — audio local) |
| 9 | After reveal: stale seek target doesn't revive; attach doesn't re-arm | P2-cleanup: `pendingVideoTargetSec = -1` at reveal; attachVideo → else branch (sync to audio, no SEEKING) | no separate target field: seek target applied immediately (seekTo / setMediaSources(startPosMs)), gate lives in PlayerState.Seeking and disappears with reveal; rotation/return re-gate only via revealVideoAfterReturn (videoReadyToShow) — intentional surface re-gate, not stale target | **YES** | Field fixed by web fix doesn't exist on Android | no |
| 10 | Old callbacks/listeners after new unit | P1-2: single pendingMetaListener slot; timeupdate re-reads current playerState; SEEKING payload replaced entirely | single ExoPlayer + single Listener for lifetime; stale protection: `videoPlayerGeneration++` (targetScene/stopAll), `videoCurrentGen`, `pendingRevealGen`, onPlayerError guard "stale (previous item)", onRenderedFirstFrame gen-guarded, onPositionDiscontinuity writes to current playerState | **YES** | Android stronger: generation guards vs single slot | no |

Scenario summary: **9 YES / 1 NO-intentional** (scenario 3 — see §3).

---

## 2. Web Fixes → Android Mechanism

| WEB FIX | ANDROID CURRENT MECHANISM | PARITY STATUS |
|---|---|---|
| **P1-2** loadedmetadata listener lifecycle (single slot) | single `Player.Listener`, attached once in createVideoPlayer; stale blocked by generation guards (`videoCurrentGen != videoPlayerGeneration`) | **EQUIVALENT** (per-src re-registration doesn't exist architecturally on Android) |
| **P2-1** enginePaused removal (write-only) | no `enginePaused` field on Android; source of truth — `PlaybackViewModel.uiState.phase` (+ fragment `playerState`) | **EQUIVALENT** (N/A — field didn't exist) |
| **P2-3** book-switch reset | MainActivity: `fragment.stopAll()` on book switch + VM.preparePlayback (deferred seek dropped if not in queue) + observeState PLAYING→SCENE_READY → stopAll() | **EQUIVALENT** (mechanism: coordinator + fragment collector, vs stopAll inside preparePlayback) |
| **P2-4** overshoot recovery (guard → `!= SEEKING`) | 50ms poll without one-shot guard + `pos < unitEndMs` — lock impossible from the start | **EQUIVALENT** (already existed; web was catching up) |
| **P1** sticky SEEKING (pause/buffer preserve payload) | pausePlayback → `Paused` (NOT sticky); buffer gate → `Paused`; fallback — READY-reveal for non-SEEKING; keepSurface-stopAll preserves gate {seekLanded:true} | **INTENTIONAL DIFFERENCE** (see §3) |
| **P2** pendingVideoTargetSec cleanup | field doesn't exist: target applied immediately in targetScene, gate lives in PlayerState.Seeking and dies with reveal | **EQUIVALENT** (N/A — problem impossible) |

Fix summary: **5 EQUIVALENT / 1 INTENTIONAL**.

---

## 3. Single real divergence: pause during incomplete seek

| | Web | Android |
|---|---|---|
| pause during SEEKING | `SEEKING{paused:true}` (sticky — gate alive, reveal after resume via gate) | `Paused` (gate reset); resume → `ShowingStoryboard` |
| why | P1 fix: otherwise resume went to SHOWING_STORYBOARD with no reveal path (timeupdate-guard + loadeddata already fired) | seek on local merged file instant, 50ms poll reveals within 50–100ms — before human tap; during incomplete seek on slow network STATE_BUFFERING→READY gives READY-reveal |
| observed contract | reveal after resume always | reveal after resume in practically reachable cases; **theoretical lock**: seek already READY + pause in 50–100ms window after tap (machine tap/auto-pause on tab switch exactly in window) — poll without gate won't reveal, STATE_READY won't re-fire (already READY) |

**Conclusion:** divergence is **intentional** (Web — deliberate fix, Android — different
architecture where problem is practically unreachable). Do NOT change Android.
Documented as Known intentional difference in T4 manual plan.

---

## 4. Summary

### Full parity (equivalent)
Scenarios 1, 2, 5, 6, 7, 8a, 8b, 9, 10 and fixes P1-2, P2-1, P2-3, P2-4,
P2-target: observed behavior matches, mechanisms differ (architecturally).

### Intentional differences
1. **Pause during seek** (scenario 3): Web sticky SEEKING{paused:true} vs
   Android Paused — intentional, practically unreachable on Android.
2. **Buffer gate during seek** (scenario 4): Web preserves gate; Android
   resets, but READY-reveal reveals on frame ready at seek target.

### Real gaps
No critical ones. Two low-priority risks (both P2, both on Android, both
practically never manifest):
- **R1 (P2):** reveal after buffer gate during seek may show frame at
  seek target (target), not gate (target+tolerance) — unit B start,
  not A tail. Observable only when network slows exactly in seek window.
- **R2 (P2):** theoretical stuck after pause-during-seek with already-READY
  player (see §3) — requires machine tap/auto-pause in 50–100ms window.

### Potential bugs
Formally — 0. Both items above are risks, not reproduced bugs; on web
corresponding classes already closed by P1/P2-4 fixes.

### Gap priorities
- R1: P2 (don't change — Android merge architecture makes this irrelevant).
- R2: P2 (don't change — practically unreachable; if full parity ever needed —
  sticky transition in Android `pausePlayback()`).

### What should NOT be changed
- Android: do NOT introduce sticky SEEKING in `pausePlayback()` (R2 not worth
  changing for theoretical case); do NOT add
  `pendingVideoTargetSec` analog; do NOT redo buffer gate.
- Web: do NOT redo reveal for Android polling; current
  timeupdate + AND-gate + sticky — contract.
- Both platforms: do NOT unify reveal mechanisms (poll vs timeupdate) —
  this is architectural difference, not a bug.
