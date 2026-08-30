# Player Audit: Architecture, Network Preloading and Caching

Date: June 17, 2026

---

## 1. Playback Architecture

### 1.1. Player Lifecycle

```
[MainActivity]
    │
    ├── GenerateViewModel ────── play() ──► Backend API ──► Chunks
    │                                                  │
    └── PlaybackViewModel ◄── playbackPrepared ────────┘
              │
              │ preparePlayback(bookId, buildId, chunkIds, positions)
              │
              ▼
         [PLAYER.IDLE] ──► [PLAYER.SCENE_READY]
                                  │
                      playSceneQueue()
                                  │
                                  ▼
                            [PLAYER.DOWNLOADING]
                                  │
                         fetchSceneData(id) ←─── Repository
                                  │
                                  ▼
                            [PLAYER.PLAYING]
                                  │
                         ┌────────┴────────┐
                         ▼                  ▼
                  handleChunk()      handleSilentChunk()
                   (audio + IU)        (IU only, timer)
                         │
                    startIuCycling()
                         │
                   onAudioCompleted()
                         │
                    currentIndex++
                         │
                    playNext() ──► loop
                         │
                    [SCENE_READY] (end of queue)
```

### 1.2. Key Components

| Component | File | Role |
|-----------|------|------|
| **MainActivity** | `MainActivity.kt` | Coordinator. Listens to `GenerateViewModel.playbackPrepared` and calls `PlaybackViewModel.preparePlayback()` |
| **PlaybackViewModel** | `PlaybackViewModel.kt` | Manages queue, preloading, player state |
| **PlayFragment** | `PlayFragment.kt` | Player UI: MediaPlayer, IU cycling, SurfaceView for video |
| **GenerateViewModel** | `GenerateViewModel.kt` | Content generation, import, `playbackPrepared` signal |
| **Repository** | `Repository.kt` | Data layer: HTTP calls + LruCache + SimpleDiskCache |
| **SimpleDiskCache** | `util/SimpleDiskCache.kt` | Disk cache with audio/video/image/preview/iu types |
| **MediaDecoder** | `util/MediaDecoder.kt` | Decodes `ByteArray` to `Bitmap` |
| **BackendApi** | `repository/BackendApi.kt` | Retrofit interface with all API endpoints |

### 1.3. Playback Queue Formation

Queue formed in `PlaybackViewModel.chunkQueue` — a `MutableList<String>` (chunk_id list).

**Formation path:**
1. `GenerateViewModel` receives `chunkIds` from `/api/v1/generate` or `/api/v1/book/{bookId}/chunks`
2. Emits `PlaybackPreparation(bookId, buildId, chunkIds, positions)` via `playbackPrepared`
3. `MainActivity` catches and calls `PlaybackViewModel.preparePlayback(bookId, buildId, chunkIds, chunkPositions)`
4. `preparePlayback` clears cache (`_repository.clearCache()`), saves chunkIds to `chunkQueue`, sets `phase = SCENE_READY`

**Also via `ensureInitialized()`:** if player not yet initialized, loads chunks via `/api/v1/book/{bookId}/chunks` and calls `preparePlayback`.

### 1.4. Queue Item Transition

Transition implemented via **`playNext()`** + **`onAudioCompleted()`**:

1. **`playNext()`** (PlaybackViewModel):
   - Takes `chunkQueue[currentIndex]`
   - First checks `preloadCache` — if exists, uses ready data
   - If not — launches `fetchSceneData(id)` in coroutine
   - Calls `emitChunk(audio, video, iuSequence)` — sets phase = PLAYING

2. **PlayFragment** reacts to phase = PLAYING:
   - In `observeState()` when `state.chunkSequence > lastProcessedChunkSequence`, calls `handleChunk()` or `handleSilentChunk()`
   - `handleChunk()` creates/chains MediaPlayer, starts IU cycling

3. **Track completion:**
   - MediaPlayer `setOnCompletionListener` → `onTrackEnd()` in PlayFragment
   - `onTrackEnd()` switches `currentPlayer = nextPlayer`, calls `playbackViewModel.onAudioCompleted()`
   - `onAudioCompleted()` increments `currentIndex++`, calls `playNext()`

4. **Double transition mechanism:**
   - `setNextMediaPlayer(nextPlayer)` — for gapless transition between two prepared MediaPlayers
   - `onTrackEnd()` + `onAudioCompleted()` — for when `setNextMediaPlayer` didn't fire

### 1.5. Data Flow Text Diagram

```
                ┌──────────────┐
                │   Backend    │
                │  (Docker)    │
                └──────┬───────┘
                       │ HTTP (JSON + streaming)
                       ▼
              ┌─────────────────┐
              │  RetrofitClient  │ OkHttp + HttpLoggingInterceptor
              │  (BackendApi)    │ connectTimeout=30s, readTimeout=15min
              └────────┬────────┘
                       │
                       ▼
              ┌─────────────────┐
              │   Repository    │
              │  ┌───────────┐  │
              │  │ LruCache  │  │ 50MB in-memory
              │  │ (mem)     │  │
              │  ├───────────┤  │
              │  │DiskCache  │  │ 256MB on disk
              │  │(SD card)  │  │
              │  └───────────┘  │
              └────────┬────────┘
                       │
              ┌────────┴────────┐
              ▼                  ▼
     PlaybackViewModel     GenerateViewModel
     ┌───────────────┐     ┌───────────────┐
     │ preloadCache   │     │ playbackPrepared│
     │ chunkQueue     │     │ (SharedFlow)  │
     │ preloadAhead() │     └───────┬───────┘
     └───────┬───────┘             │
             │                     ▼
             ▼              ┌──────────────┐
      ┌─────────────┐       │ MainActivity │
      │ PlayFragment │◄─────│  coordinator  │
      │ MediaPlayer  │      └──────────────┘
      │ IU cycling   │
      │ Video overlay│
      └──────────────┘
```

---

## 2. Network Preloading (MOST IMPORTANT SECTION)

### 2.1. Current Implementation

Preloading implemented in `PlaybackViewModel.preloadAhead()`:

```kotlin
private const val PRELOAD_AHEAD = 3  // preload 3 scenes ahead
private val preloadCache = mutableMapOf<String, PreloadedScene>()
```

**How it works:**
1. After `playSceneQueue()` or `playNext()`, `preloadAhead()` is called
2. For each `offset` from 1 to `PRELOAD_AHEAD` (3 scenes):
   - Calculates `idx = currentIndex + offset`
   - If `preloadCache` already contains chunk_id — skips
   - Otherwise launches `fetchSceneData(id)` in same coroutine
   - Saves result in `preloadCache[id]`
3. When `playNext()` gets requested chunk, it first checks `preloadCache`
4. If cache hit — uses ready data without network request
5. If miss — synchronously loads via `fetchSceneData()`

**Sequential problem:**
- `preloadAhead()` uses **single coroutine** for ALL preloads (`for` loop)
- Preloads launch sequentially: first offset=1, then offset=2, then offset=3
- This means next scene (offset=2) only loads after offset=1 completes
- If offset=1 scene is large (audio + IU images), offset=2 starts only after completion

### 2.2. What Gets Loaded

`fetchSceneData(id)` loads **three components in parallel** via `async`:

```kotlin
val audioDeferred = async { 
    if (chunk?.audio_ready == true) repository.getChunkAudio(id) 
    else byteArrayOf()
}
val videoDeferred = async { 
    if (chunk?.video_ready == true) repository.getChunkVideo(id) 
    else null 
}
val iuDeferred = async { 
    fetchIuSequence(id)  // storyboard + IU images
}
```

**IU images** load sequentially inside `fetchIuSequence()`:
```kotlin
storyboard.ius.map { iu ->
    repository.getIuImage(bkId, chId, scId, iu.unit_id, bldId)  // each call = separate HTTP request
}
```

### 2.3. HTTP Range Requests

**NOT USED.** All media endpoints marked `@Streaming`:
- `GET /chunk/{id}/audio` — downloads entire MP3 file
- `GET /chunk/{id}/image` — downloads entire PNG image
- `GET /chunk/{id}/video` — downloads entire MP4 file
- `GET /iu-image/{book}/{ch}/{sc}/{iu}` — downloads each IU image as separate request

No `Range: bytes=...` headers used. This means:
- Audio file downloads **completely** before playback starts
- Video file downloads **completely** before display starts
- Each IU image — separate full HTTP request

### 2.4. Local Storage

Yes, downloaded data is saved:

**1. In-memory cache (LruCache):**
- `Repository` has `LruCache<String, ByteArray>(50 * 1024 * 1024)` — 50MB
- Keys: `"audio_$chunkId"`, `"image_$chunkId"`, `"video_$chunkId"`, `"iu_${book}_${ch}_${sc}_${iu}"`
- Stores raw bytes in memory

**2. SimpleDiskCache (disk):**
- Path: `app.cacheDir/media-cache/{audio,video,image,preview,iu}/`
- Limit: 256MB
- On limit reached, oldest files deleted (LRU)
- Types: audio (mp3), video (mp4), image (png), preview (png), iu (png)

**3. Temp files for MediaPlayer (PlayFragment):**
- Audio: `cacheDir/chunk-{timestamp}.mp3` or via `repository.cacheAudioFile()`
- Video: `cacheDir/video-{timestamp}.mp4` or via `repository.cacheVideoFile()`

### 2.5. Bottlenecks and Track Gaps

**Problem 1: Sequential IU image loading**
In `fetchIuSequence()`, all IU images for scene load sequentially, each as separate HTTP request. Scene with 10 IU = 10 sequential HTTP round-trips. At 100-200ms network latency, adds 1-2 seconds per scene.

**Problem 2: No partial audio loading**
Audio loads completely via `repository.getChunkAudio()` → `body.bytes()`. Must wait for full download before playback. For scene with 30-second audio (~500KB MP3), slow network can mean 5-10 seconds waiting.

**Problem 3: preloadAhead() runs in single coroutine**
```kotlin
for (offset in start..PRELOAD_AHEAD) {
    val data = fetchSceneData(id)  // sequential
    preloadCache[id] = data
}
```
This means scene+3 loading starts only after scene+1 fully loads. No parallel multi-scene preloading.

**Problem 4: Double caching with different strategies**
- `LruCache` (50MB) — eviction by size, no recency consideration
- `SimpleDiskCache` (256MB) — eviction by last modified date (LRU)
- No synchronization between them: data may be on disk but not in memory, and vice versa

**Problem 5: MediaPlayer requires full file**
`MediaPlayer.setDataSource(file.absolutePath)` requires complete audio file on disk. No streaming playback. This means:
- File must be fully written to disk before playback starts
- For next scene transition, its audio file must also be fully on disk

---

## 3. Android Caching

### 3.1. Where User Settings Are Stored

**SharedPreferences:**
- `animastor` (standard XML shared preferences)
- Stored: `bookId`, `buildId` (for restart recovery)

### 3.2. Multi-level Caching

```
Data request
     │
     ▼
┌─────────────┐
│  LruCache   │  ← 50MB in-memory (primary)
│  (mem)      │
└──────┬──────┘
       │ miss
       ▼
┌─────────────┐
│ SimpleDisk  │  ← 256MB on disk (secondary)
│ Cache       │   LRU eviction
└──────┬──────┘
       │ miss
       ▼
┌─────────────┐
│   Backend   │  ← HTTP request via Retrofit
│   API       │
└─────────────┘
```

**Cached data:**

| Type | In-memory (LruCache) | Disk (SimpleDiskCache) | Invalidation Strategy |
|-----|---------------------|----------------------|----------------------|
| Chunk audio | `audio_$id` | `audio/` (mp3) | LruCache: at 50MB capacity. Disk: LRU at 256MB |
| Chunk image | `image_$id` | `image/` (png) | Same |
| Chunk video | `video_$id` | `video/` (mp4) | Same |
| IU image | `iu_${b}_${ch}_${sc}_${iu}` | `iu/` (png) | Same |
| Preview image | `pr_${b}_${ch}_${sc}_${iu}` | `preview/` (png) | Same |
| Storyboard (IU metadata) | NOT cached | NOT cached | Always server request |

**Data NOT cached and reloaded each time:**
1. `getChunkStoryboard(id)` — every time GET request
2. `getAllChunks(bookId)` — every time GET request
3. `getBook(bookId)` — every time GET request
4. `getChunk(id)` — every time GET request (checking `audio_ready`, `image_ready`, `video_ready`)

### 3.3. Cache Invalidation

**When cache is cleared:**
1. **`preparePlayback()`** — calls `_repository.clearCache()` → clears LruCache + SimpleDiskCache
   - Happens on every new playback
   - Problem: even if data unchanged, cache fully reset
2. **`clearCache()` in Repository** — `cache.evictAll()` + `diskCache?.evictAll()`
3. **`trim()` in SimpleDiskCache** — automatically deletes oldest files on exceeding 256MB
4. **LruCache** — automatic eviction at 50MB (Android built-in LRU algorithm)

### 3.4. Critical Caching Issues

**Issue A: Full cache clear on preparePlayback**
```kotlin
fun preparePlayback(...) {
    _repository.clearCache()  // ← deletes ALL cached IU images, audio, video
    preloadCache.clear()      // ← clears preloaded data
```
On reopening same book, all IU images reload from scratch.

**Issue B: Storyboard not cached**
`getChunkStoryboard(id)` requested:
- In `ensureInitialized()` for all chunks
- In `playSceneQueue()` via `loadCoverIntoState()`
- In `fetchIuSequence()` for each chunk during preloading

Storyboard contains IU metadata (durations, texts) — unchanged, but loaded every time.

**Issue C: getChunk() called multiple times**
In `fetchSceneData()`:
```kotlin
val chunk = runCatching { _repository.getChunk(id) }.getOrNull()  // ← 1st request
// ...
if (chunk?.audio_ready == true) {
    val audio = repository.getChunkAudio(id)  // ← 2nd request (streaming)
}
if (chunk?.video_ready == true) {
    val video = repository.getChunkVideo(id)  // ← 3rd request (streaming)
}
```
Meanwhile `getChunk(id)` returns `ChunkResponse` (JSON) — this info **not cached**.

---

## 4. Efficiency Analysis

### 4.1. What Works Well

1. **Parallel audio/video/IU loading** — `fetchSceneData()` uses `async` for parallel loading of three components
2. **Two-level caching** — in-memory (LruCache) + disk (SimpleDiskCache)
3. **3-scene ahead preloading** — `PRELOAD_AHEAD = 3` provides buffer
4. **Gapless transition via setNextMediaPlayer** — Android MediaPlayer supports pre-chaining
5. **Timer-based IU cycling for silent scenes** — when no audio, IU switches by timer
6. **Clean GenerateVM/PlaybackVM separation** — player independent of generation

### 4.2. Inefficient Implementations

1. **Sequential IU image loading** — each IU image = separate HTTP request, all sequential
2. **Full audio download before playback** — no streaming/progressive download
3. **Single coroutine for all preloading** — `preloadAhead()` loads scenes one-by-one, not in parallel
4. **Full cache clear on preparePlayback** — resets all cached data
5. **Storyboard not cached** — IU metadata reloaded repeatedly
6. **HTTP logging Level.BODY** — logs all media files in base64, creating huge strings and GC pressure

### 4.3. Potential Lag Sources

| Source | Description | Severity |
|----------|----------|---------|
| **Sequential IU HTTP requests** | Scene with 10 IU = 10 sequential round-trips | **High** |
| **PreloadAhead in single coroutine** | Scene+2 waits for scene+1 to fully load | **Medium** |
| **No audio streaming** | Full MP3 download before start | **Medium** |
| **Storyboard not cached** | Repeated metadata requests | **Low** |
| **Level.BODY logging** | Binary data conversion to string, GC pressure | **Medium** (empirically proven) |
| **clearCache on preparePlayback** | Reset of all cached IU images | **Medium** |

### 4.4. Recommended Improvements (priority order)

1. **Parallel scene preloading** — launch `fetchSceneData()` for offset=1,2,3 in parallel, not sequentially
2. **Storyboard caching** — add `IuItem` data to LruCache/DiskCache, they don't change
3. **Partial audio loading** — use `Range: bytes=0-...` to start playback before full download
4. **Parallel IU image loading** — launch `async { fetchIuImage() }` in parallel for all scene IU
5. **Selective cache invalidation** — don't clear all cache on preparePlayback, only if buildId changed
6. **Level.HEADERS** — enable for production (but need to understand why it breaks)

---

*Audit performed without code changes. Based on analysis of: PlayFragment.kt, PlaybackViewModel.kt, Repository.kt, BackendApi.kt, RetrofitClient.kt, SimpleDiskCache.kt, MediaDecoder.kt, GenerateViewModel.kt, ChunkResponse.kt, StoryboardResponse.kt.*
