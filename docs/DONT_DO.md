# ⛔ Changes That Must NOT Be Made

This file contains a list of changes that previously caused critical regressions in the player, playback queue, or event model. **Never repeat these.**

## Player (PlayFragment.kt)

### 1. Stall/retry mechanism for IU images
**Forbidden:** Adding stall/retry logic to the IU cycling loop that pauses audio when an image is missing and waits for it to load.

- `4c25fad` — IU stall/retry: audio waits for image
- `9d1f7f6` — stall hang fix
- Reason: blocks the playback loop, causes player hangs

### 2. Sliding window preload
**Forbidden:** Completely rewriting the sliding window preload mechanism.

- `663e598` — sliding window preload
- Reason: rewritten preload breaks sequential queue playback

### 3. Complex logic for missing IU images
**Forbidden:** Adding conditional checks `nextIu.bitmap == null || nextIu.status != IuStatus.READY` in the IU cycling loop with IU skipping.

- `c80e53f` — keep previous image when IU is not generated
- Reason: leads to inconsistent IU index state and hanging on a single frame

### 4. Double call to switchToPlayTab() (NavigationEvent)
**Forbidden:** Adding `setupNavigationEventObserver()` in MainActivity that calls `switchToPlayTab()` if FileFragment already does the same via `navigationEvent.collect` or `uiState.collect`.

- `ddc4f1b` (revert) — NavigationEvent broke the player
- Reason: `FragmentTransaction.commit()` is asynchronous. When `switchToPlayTab()` is called twice in a row, **two** PlayFragment instances are created which conflict. Only FileFragment should handle navigation.

**Correct approach:** NavigationEvent should only be collected in FileFragment, NOT in MainActivity. MainActivity should NOT have `setupNavigationEventObserver()`.

## Caching

### 5. Removing clearCache in preparePlayback
**Forbidden:** Removing the `_repository.clearCache()` call in `preparePlayback()`.

- `be49b84` — remove aggressive clearCache
- Reason: causes stale/wrong images to appear when switching between books

## Approach Changes

### 6. Deleting functions without checking all references
**Forbidden:** Deleting exported functions without verifying all call sites via code search.

- `ff1809e` — deleted `unregisterAudio/Image/Video`, `saveBookJson`, `deleteBookJson`, `getBookContentHash`
- Reason: functions may be called from dynamic require or via prototype chain

### 7. Changing data class field type from `var` to `val`
**Forbidden:** Changing `var` to `val` in a data class if the field may be updated from elsewhere (e.g., `IuImageItem.bitmap`).

- `ffd420b` — revert included changing `var bitmap` → `val bitmap` in `IuImageItem`
- Reason: field may be updated in-place by the stall-retry mechanism

### 8. helmet/rate-limit without Android WebView compatibility testing
**Forbidden:** Adding helmet middleware without verifying that security headers (Content-Type, CSP) are compatible with the frontend.

- `d6ac6c1` — added helmet and express-rate-limit
- Reason: helmet may block headers expected by the Android client

### 9. graceful-shutdown with redis.quit() without checking active operations
**Forbidden:** Calling `redis.quit()` in graceful-shutdown without guaranteeing no active operations.

- `d6ac6c1` — graceful-shutdown with redis.quit()
- Reason: may interrupt active generations and cause data loss

### 10. Changing HTTP logging level from BODY to HEADERS
**Forbidden:** Changing `HttpLoggingInterceptor.Level.BODY` to `LEVEL.HEADERS` in RetrofitClient.kt.

- Step 1.2 — BODY → HEADERS
- Reason: after this change the player stopped playing the queue (direct causal link not established, but reverting fixed the problem)

### 11. Restoring Player dependency on `video_start_ms`
**Forbidden:** Forcing Player (Android `PlayFragment.kt` / Web `playbackStore.ts`) to read, compute, or consume `video_start_ms`.

- Contract (audio master timeline): **Audio = semantic master timeline (`start_ms`), Storyboard = selected unit, Video = visual follower** — Player lives only on `start_ms`. `video_start_ms` is computed in backend (`backend/src/video/video-timeline.js`) as best-effort and used ONLY in Final Assembly (precise boundaries on export).
- Do not introduce `videoStartMs` in `IuImageItem`/`IuItem`/`StoryboardIu`/`RawIu` and in Player state.
- Even if boundary desync reappears in a specific LTX test (8N+1), fix alignment in video preparation/assembly, not by adding a second time model to Player.
- Reason: the second time scale created a second timeline and desynchronization; removed as part of the audio master timeline refactor.

## Pre-Change Checklist

Before making any changes to player files (PlayFragment.kt, PlaybackViewModel.kt, Repository.kt):

1. ✅ Verify via code search that the deleted code is not used
2. ✅ Build APK (`./gradlew assembleDebug`)
3. ✅ Verify the player opens
4. ✅ Verify queue playback works
5. ✅ Verify pause/resume works
6. ✅ Verify scene transitions work
