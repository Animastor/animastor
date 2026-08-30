# Player State After Regeneration

## Problem

After GPU generation completes, the book content is updated, but the player remains in the old state. If the player is simply restarted (`preparePlayback` → `SCENE_READY`), the user loses position, current phase (paused is reset), and the UI glitches.

## Solution: Soft Refresh

Concept: **"Generation does not control the player. Generation updates the content."**

After generation completes, a full player reset is not triggered. Instead:

1. `GenerateViewModel` emits `PlaybackPreparation` with flag `softRefresh = true`
2. `MainActivity` calls `PlaybackViewModel.refreshContent()` instead of `preparePlayback()`
3. Player remains in current phase (PAUSED → PAUSED, PLAYING → PLAYING)
4. Flag `needsContentRefresh = true` is set
5. On next Play press — refetch fresh content for the current scene

## Architecture

```
GenerateViewModel.onGenerationComplete()
  │
  ├─ loadCoverBitmap(coverId)         ← with retry (5 attempts, ~17s backoff)
  │
  └─ _playbackPrepared.tryEmit(
       PlaybackPreparation(
         bookId, buildId, chunkIds, positions,
         coverImage = cover,            ← cover for fallback background
         softRefresh = true             ← SOFT REFRESH FLAG
       )
     )
       │
       ▼
MainActivity.setupPlaybackCoordination()
  │
  ├─ softRefresh == true
  │   └─ playbackViewModel.refreshContent(...)
  │       ├─ clears preloadCache
  │       ├─ updates chunkQueue, buildId, positions
  │       ├─ _repository.clearCache()   ← unconditionally (buildId changes)
  │       │
  │       ├─ PAUSED / PLAYING:
  │       │   ├─ needsContentRefresh = true
  │       │   └─ return (phase unchanged)
  │       │
  │       └─ IDLE / SCENE_READY:
  │           └─ full reset (same as preparePlayback)
  │
  └─ setCoverImage(cover)              ← always, if cover != null
```

## Mechanisms

### 1. `needsContentRefresh`

Flag in `PlaybackViewModel`. Set by `refreshContent()` when the player was in PAUSED or PLAYING.

On next `resumePlayback()` (Play press):
- Flag is cleared (`needsContentRefresh = false`)
- Instead of simple `PLAYING`, a coroutine is launched:
  - `_uiState.update { phase = DOWNLOADING }`
  - `playNext()` → `fetchSceneData(id)` → refetch audio/images
  - `emitChunk()` → PLAYING with fresh content

```kotlin
fun resumePlayback() {
    if (needsContentRefresh) {
        needsContentRefresh = false
        viewModelScope.launch {
            _uiState.update { it.copy(phase = PlayerPhase.DOWNLOADING) }
            playNext()
        }
        return
    }
    _uiState.update { it.copy(phase = PlayerPhase.PLAYING) }
}
```

### 2. Player cleanup in PlayFragment

When `needsContentRefresh == true`, the fragment releases old players BEFORE refetching:

```kotlin
if (playbackViewModel.needsContentRefresh) {
    currentPlayer?.release()    // ← old MediaPlayer with placeholder
    nextPlayer?.release()
    videoPlayer?.release()
    currentPlayer = null
    isPaused = false
    playbackViewModel.resumePlayback()  // ← refetch new audio
    return
}
```

Without this, the old `MediaPlayer` would start playing immediately (`currentPlayer?.start()`), and new audio would attach as `nextPlayer` — the user would hear the old placeholder.

### 3. Cover as fallback background

After generation, `onGenerationComplete()` loads the cover via `loadCoverBitmap()` with retry:

```kotlin
var cover: Bitmap? = null
if (coverId != null && imageEnabled) {
    cover = loadCoverBitmap(coverId)
    if (cover == null) {
        for (retry in 1..5) {  // ~17s total backoff
            delay((1000L shl minOf(retry, 3)).coerceAtMost(5000))
            cover = loadCoverBitmap(coverId)
            if (cover != null) break
        }
    }
}
```

`MainActivity` always calls `setCoverImage(cover)` if `cover != null`. In PlayFragment state collector:

```kotlin
if (state.coverImage != null) {
    b.curtainsImage.visibility = View.GONE
    b.coverImage.setImageBitmap(state.coverImage)
    b.coverImage.visibility = View.VISIBLE
    hasDisplayedCover = true
}
```

After the cover is set, theater curtains (`curtainsImage`) are never shown again for this book.

### 4. buildId and cache invalidation

`buildId` — backend content version identifier. Used in cache keys:

```
cacheKey = "audio_${id}_${buildId}"
diskKey  = "${buildId}_$id"
```

After regeneration, `startGeneration()` saves the new `build_id` from the `/regenerate` response:

```kotlin
if (res.build_id != null) {
    persistBuildId(res.build_id)  // ← buildId updated
}
```

Changing `buildId` invalidates old cache keys — `getChunkAudio()` gets a cache miss and loads fresh data from the backend.

Additionally, `refreshContent()` always calls `_repository.clearCache()` as a safeguard.

### 5. Cache cleanup

| Location | When | What is cleaned |
|-----|-------|-----------|
| `startGeneration()` | Generation start | `_repository.clearCache()` |
| `refreshContent()` | Generation completion | `_repository.clearCache()` (unconditionally) |
| `preparePlayback()` | New book / buildId change | `_repository.clearCache()` (conditionally, on buildId change) |

## Scenarios

### Scenario A: User paused → generation → Play

1. Player PAUSED on scene 5
2. Generation started (Audio + Image)
3. Generation completes → `onGenerationComplete()`
4. `refreshContent()`:
   - Clears cache
   - Updates `chunkQueue`, `buildId`
   - `needsContentRefresh = true`
   - Phase remains **PAUSED**
5. `setCoverImage(cover)` → UI updates cover, curtains removed
6. User presses Play
7. `resumePlayback()` → `needsContentRefresh == true`
   - Fragment releases old MediaPlayer
   - `playNext()` → DOWNLOADING → `fetchSceneData(5)` → fresh audio
   - `emitChunk()` → PLAYING → new MediaPlayer plays scene 5
8. **Result:** position preserved, cover in place, new audio playing

### Scenario B: User playing → generation → current scene ends

1. Player PLAYING on scene 5
2. Generation completes → `refreshContent()`
3. `needsContentRefresh = true`, phase remains **PLAYING**
4. Current MediaPlayer finishes playing scene 5 (old audio)
5. `onAudioCompleted()` → `playNext(6)` → `fetchSceneData(6)` → fresh audio for scene 6
6. Scene 6 plays with new content
7. **Result:** current scene finishes playing, next scenes have fresh content

### Scenario C: New book (no generation)

1. `generateFromFile()` / `loadBookFromFile()`
2. `softRefresh = false` (default)
3. `MainActivity` calls `preparePlayback()`:
   - `chunkQueue.clear()`, `currentIndex = 0`
   - `_uiState.update { phase = SCENE_READY }`
   - If buildId changed → `_repository.clearCache()`
4. `setCoverImage(cover)` → cover, curtains removed
5. **Result:** full reset, player ready for playback

## Removed/dead mechanisms

- **`coverUpdated` channel** — was declared in `GenerateViewModel` but `_coverUpdated.tryEmit()` was never called. Removed. Cover is now delivered exclusively through `PlaybackPreparation.coverImage`.
