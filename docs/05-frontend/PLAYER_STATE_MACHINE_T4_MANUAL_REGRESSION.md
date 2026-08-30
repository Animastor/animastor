# T4 — Manual Regression: Web Player (real timing/lifecycle)

Status: 📝 Plan → (to be filled during execution).
Base: `PLAYER_STATE_MACHINE_AUDIT_T6.md` — all code fixes in the series are closed
(P0-1, P1-1, P1-2, P2-1, P2-3, P2-4, P1 sticky SEEKING, P2 target cleanup).
Unit tests: vitest 38/38. T4 is the only remaining audit step: verify
**real** timings/network latency/UI-lifecycle that unit tests do
not cover.

Goal: confirm that the chain
`audio position → selectedUnit → external seek → SEEKING → video seek → seekLanded
→ onVideoTimeUpdate → reveal gate → VIDEO_READY / PLAYING`
is consistent in a live browser, and that no scenario produces stale frame /
stale storyboard / permanently hidden video / spurious seek / infinite loading.

---

## Preparation (for each run)

- [ ] Fresh web build (`frontends/app`), working book with ≥2 scenes, each scene ≥2
      units (ideally with server `start_ms`; legacy-cumulative — separate run).
- [ ] Book with short units (< 300 ms) — mandatory for overshoot cases.
- [ ] Two different books A and B (for book-switch cases).
- [ ] Chrome DevTools open, Network + Performance; **Throttling: Slow 3G**
      (for buffering cases) — enable only in tests where specified.
- [ ] Logs: `console` (video errors write `[PLAY-STREAM] ...`), screenshots
      on every FAIL.

---

## Test Cases

Recording format: ACTION / EXPECTED / ACTUAL / PASS/FAIL / SCREENSHOT-LOG (on FAIL).

---

### T4-1. Navigator → Unit A → playback

- **ACTION:** Cold start → open book → Play → select Unit A in Navigator
  (first unit of scene).
- **EXPECTED:** Storyboard A shown immediately; video reveals after seek lands
  (first correct frame A); audio plays from start of unit A; no
  "black screen", no old frame.
- **ACTUAL:** …
- **PASS/FAIL:** …
- **SCREENSHOT/LOG:** …

---

### T4-2. During playback quickly select Unit B

- **ACTION:** Unit A playing → tap Unit B in Navigator.
- **EXPECTED:**
  - Visual transition criterion (see "Unit A → Unit B transition criterion"):
    no sequence "A last frame → A storyboard → B storyboard
    → B video" with black/old frame; expect clean A → B storyboard /
    first valid frame B → playback B.
  - `selectedUnit` = B; video stays attached (same scene — seek without
    re-src); video reveals when position is inside B (gate), not earlier.
  - Audio not interrupted/skipping; B subtitles are current.
- **ACTUAL:** …
- **PASS/FAIL:** …
- **SCREENSHOT/LOG:** …

---

### T4-3. Fast A → B → C (before metadata ready)

- **ACTION:** A playing → quickly tap B, then C (faster than B video loads);
  if B and C are in same scene — same for units.
- **EXPECTED:** Finally plays C (target C, storyboard C, then video C);
  stale target B is not applied anywhere (no jump to B after
  C is already selected); video doesn't get stuck hidden.
- **ACTUAL:** …
- **PASS/FAIL:** …
- **SCREENSHOT/LOG:** …

---

### T4-4. A → B → A fast

- **ACTION:** A playing → B → immediately back to A.
- **EXPECTED:** Finally plays A; frame/position match A (not tail of B);
  no stale frame; reveal via A gate.
- **ACTUAL:** …
- **PASS/FAIL:** …
- **SCREENSHOT/LOG:** …

---

### T4-5. Pause during SEEKING

- **ACTION:** Tap Unit B and **immediately** (while video is seeking, wider window
  on Slow 3G) press Pause.
- **EXPECTED:** State remains SEEKING{paused:true} (sticky); storyboard B
  on screen; video hidden; no "stuck hidden video" afterward.
- **ACTUAL:** …
- **PASS/FAIL:** …
- **SCREENSHOT/LOG:** …

---

### T4-6. Play after Pause (from T4-5)

- **ACTION:** Continuation of T4-5 → press Play.
- **EXPECTED:** Seek continues (not restarted, no extra jump);
  video reveals via gate (first frame B, not tail of A); playback continues
  from B position; no jump back to unit start.
- **ACTUAL:** …
- **PASS/FAIL:** …
- **SCREENSHOT/LOG:** …

---

### T4-7. Buffering/network slowdown during SEEKING

- **ACTION:** Throttling Slow 3G → tap Unit B → wait for "Loading…"
  (buffer gate) before seek lands.
- **EXPECTED:** Buffer gate maintains SEEKING{paused:true} (not PAUSED, not
  SHOWING_STORYBOARD); after buffer accumulates → exit → SEEKING{paused:false} →
  reveal B; should not have: infinite loading, video permanently hidden, video
  returning to unit start, double seek.
- **ACTUAL:** …
- **PASS/FAIL:** …
- **SCREENSHOT/LOG:** …

---

### T4-8. Video layer OFF → ON during playback

- **ACTION:** Scene with video playing → disable Video chip → re-enable after 2–3 seconds.
- **EXPECTED:** On OFF — storyboards continue cycling (audio does not
  stop); on ON — video continues from **current audio position**
  (not from old unit position, not from scene start); no "Loading…" loop,
  no long/infinite buffering; video position ≈ audio position (±0.5s).
- **ACTUAL:** …
- **PASS/FAIL:** …
- **SCREENSHOT/LOG:** …

---

### T4-9. Video layer OFF → ON during SEEKING

- **ACTION:** Tap Unit B → during seek disable Video → re-enable.
- **EXPECTED:** Gate lives hidden; after ON video syncs to audio
  (audio already at target B) and reveals when position enters unit B;
  no "stuck hidden video", no stale frame A.
- **ACTUAL:** …
- **PASS/FAIL:** …
- **SCREENSHOT/LOG:** …

---

### T4-10. Switch Unit during SEEKING

- **ACTION:** Tap Unit B → during incomplete seek tap Unit C.
- **EXPECTED:** Old seek does not affect C: final target C, gate C;
  no application of stale target B after C is selected; video reveals via C.
- **ACTUAL:** …
- **PASS/FAIL:** …
- **SCREENSHOT/LOG:** …

---

### T4-11. Switch book during playback

- **ACTION:** Book A playing → open book B (from list/library) →
  Play in B.
- **EXPECTED:** A audio stops; no stale A frame/storyboard on
  SCENE_READY B (B cover/curtains); selectedUnit/currentIuBlobUrl clean;
  first scene B starts normally; no unexpected start of book A playback
  over B.
- **ACTUAL:** …
- **PASS/FAIL:** …
- **SCREENSHOT/LOG:** …

---

### T4-12. Switch book during SEEKING

- **ACTION:** A playing → tap unit (SEEKING) → immediately open book B.
- **EXPECTED:** All A states reset (IDLE on B open); deferred/in-flight
  seek from A does not execute against B (B playback doesn't start "on its
  own"); stale pending target not applied; B starts normally.
- **ACTUAL:** …
- **PASS/FAIL:** …
- **SCREENSHOT/LOG:** …

---

### T4-13. Pause → Resume after video frame already shown

- **ACTION:** Wait for reveal (video visible) → Pause → 2 seconds → Play.
- **EXPECTED:** Pause → video stays visible (VIDEO_READY, not storyboard);
  Resume → playback continues from same position; **no video return
  to unit start** (stale target already cleared); no re-seek.
- **ACTUAL:** …
- **PASS/FAIL:** …
- **SCREENSHOT/LOG:** …

---

### T4-14. Attach/detach video through real UI lifecycle (multiple times)

- **ACTION:** Scene with video playing → switch to another tab
  (Navigator/back) and back to Play — repeat 3–5 times; variant: minimize/
  restore browser tab.
- **EXPECTED:** Each remount: video re-attaches without position loss (synced to
  audio); short storyboard before first frame (normal), then reveal;
  no unnecessary SEEKING re-arming, no
  stuck hidden video, no black frame; after several cycles —
  stable playback.
- **ACTUAL:** …
- **PASS/FAIL:** …
- **SCREENSHOT/LOG:** …

---

### T4-15. Absence of stale artifacts (cross-cutting check of all above cases)

- **ACTION:** In each of T4-1…T4-14, note the absence of:
  - [ ] old frame from previous unit;
  - [ ] old storyboard (image A on unit B);
  - [ ] old video frame (frame A over B);
  - [ ] stuck hidden video (audio plays, video never appears);
  - [ ] video returning to unit start (position jump);
  - [ ] unexpected re-seek (video jumps without user action);
  - [ ] infinite loading ("Loading…" without completion);
  - [ ] stale subtitle/image (subtitle/image doesn't match current unit).
- **ACTUAL:** …
- **PASS/FAIL:** …
- **SCREENSHOT/LOG:** …

---

## Unit A → Unit B transition criterion (visual)

There should **NOT** be a chain with gaps/artifacts:

```
A last frame → A storyboard → B storyboard → B video
(with black frame, old frame flash, "black screen" delay)
```

**Normal result:**

```
A (playing)
→ clean transition (instant, no black/stale frame)
→ B storyboard (image of unit B, while video positions)
→ B video (first frame B revealed via gate — not tail of A)
→ playback B
```

Acceptable: brief storyboard B display over video element during
seek (this is by design — reveal gate). Unacceptable: showing frame/tail of A after
B is selected; black rectangle; video revealed BEFORE position enters unit B.

### Video OFF → ON: position criterion

After enabling, video should continue from **current audio position**
(not from old unit position, not from scene start). Acceptable delta — no
more than ~0.5s (and it self-corrects). Unacceptable: video jumps to scene
start/old unit, reload from scratch, "Loading…" loop.

---

## Known intentional difference

| Platform | Pause during incomplete seek |
|---|---|
| **Web** | `SEEKING{paused:true}` (sticky — gate preserved; P1 fix) |
| **Android** | `Paused` (payload reset; practically unreachable — instant local seek + 50ms poll) |

**Do not count as FAIL.** Platform behavior intentionally differs; on web
sticky semantics give reveal after resume, on Android reveal completes
before human tap. If T4-5/T4-6 on web behavior matches sticky contract — test is PASS.

---

## Final Criteria

### T4 PASS criteria

All **mandatory** tests = PASS, and T4-15 notes no
stale artifacts / hidden video / spurious seek / infinite loading.

### Mandatory tests

- T4-1 (basic start),
- T4-2 (A → B during playback) — including visual transition criterion,
- T4-5 + T4-6 (pause/resume during SEEKING — sticky contract),
- T4-8 (Video OFF → ON during playback) — including position criterion,
- T4-11 (book switch during playback),
- T4-13 (pause/resume after reveal — no return to unit start),
- T4-15 (no stale artifacts).

### Optional (recommended, but not blocking)

- T4-3 (fast A → B → C),
- T4-4 (A → B → A),
- T4-7 (buffering on Slow 3G — needs throttle),
- T4-9 (Video OFF → ON during SEEKING),
- T4-10 (unit switch during SEEKING),
- T4-12 (book switch during SEEKING),
- T4-14 (multiple attach/detach).

### Failure classification

- **P0 (run blocker):** permanently hidden video (audio plays, video never
  reveals); infinite loading; stale previous unit frame over
  new; "video jumps to unit start" on resume; book A continues playing
  over book B.
- **P1 (critical, but not run blocker):** A→B transition with visible black
  frame/tail of A > 1 frame; Video OFF→ON without position alignment; repeated
  unexpected seek; stale subtitle/image longer than one unit.
- **P2 (cosmetic/perf):** single storyboard flash during reveal;
  minor (>0.5s, but self-correcting) video/audio position
  divergence after Video ON; extra network request on same-scene unit-tap (known
  residual risk, not a bug).
