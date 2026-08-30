# Research: Video Loading and Startup Mechanism (Web + Android)

Date: 2026-08-15. Status: research without code changes (see last section
if optimizations already implemented).

## Problem

In Navigator, selecting a unit actually loads the entire scene's video (one
`.mp4` per scene, ~20–43 MB). First load is noticeably slow: Player shows
"loading" state for a long time, giving impression that application fully
downloads video before starting playback. After first load, navigation
between units within scene is fast — so bottleneck is in
initial video retrieval/preparation.

## 1. Web Frontend — how video loading works now

Path: `frontends/app/src/state/playbackStore.ts` + `frontends/app/src/api/client.ts`.

1. Unit selection in Navigator → `seekToPosition()` → `executePendingSeek()` → phase
   **`DOWNLOADING`** (this is "loading" in player).
2. `playNext()` → `fetchSceneData(sceneKey)`:
   - `GET /api/v1/scene/{book}/{ch}/{scene}/status?build_id=` — JSON;
   - **in parallel** via `Promise.all`: audio blob + **video blob** +
     storyboard + **all scene IU images**.
3. Video: `getBlob()` (`api/client.ts`) — regular `fetch` with
   `Accept: application/octet-stream`, **no Range header**. Body read
   entirely (`reader.read()`) into memory → assembled `Blob` → stored in Cache API
   (`putMedia`) → `URL.createObjectURL()`.
4. Only then `emitScene()` → `handleChunk()` → `playVideoOverlay()`
   sets `<video src=blobUrl>`. Element (`PlayPage.tsx`, `preload="auto"`,
   `playsInline`) **never sees network** — plays from already downloaded blob.
5. First frame (IU image) also appears only after `emitScene`, i.e. after
   full download of entire bundle.

Conclusion: **entire MP4 fetched completely before media element creation**. No Range,
no progressive, no "start playing earlier" — none.

## 2. Android Frontend — how video loading works now

1. Player: `android.media.MediaPlayer` ×3 (`PlayFragment.kt`: `currentPlayer` /
   `nextPlayer` — audio, `videoPlayer` — video), plays **from local file**
   (`setDataSource(file.absolutePath)` + `prepare()`).
2. `PlaybackViewModel.fetchSceneData()` — same scheme: status → **parallel**
   audio + video + all IU → only then `emitScene()`.
3. Video: `Repository.getSceneVideo()` → Retrofit `@Streaming` endpoint, but then
   `body.bytes()` — **full ByteArray in memory** → LruCache (50 MB) +
   SimpleDiskCache → `playVideoOverlay()` writes temp file `video-*.mp4` →
   `MediaPlayer` from file.
4. OkHttp: `readTimeout 15 min`, no cache interceptor, no Range — full body.

Conclusion: **full load to memory/disk before player creation**. No streaming.

## 3. Where exactly delay occurs

Delay is **network: full scene fetch before first frame**, not decoder/metadata
preparation. Two independent components:

**a) Client waits for full download (primary).** Both clients before player creation
wait for `audio + video + all IU` (in web even first static frame waits for entire
fetch: `showIu` called after `emitScene`). No Range requests made by any
"Play" page.

**b) File not prepared for progressive (hidden bottleneck).** Verified on
real files on disk (`data/output/...`):

```
merged scene mp4:  43.6 MB, duration 63.8s, bitrate 5.47 Mbps
  ftyp @0% → mdat @0%…100% → moov @100% (19.2 KB at end of file)
group clip g1:     6.1 MB, moov @99.8%
```

**moov at end of file** — no `-movflags +faststart` anywhere in pipeline
(`concatVideos` — `-c copy`; `forceKeyframesAtUnitBoundaries` — full re-encode,
but also without faststart). Even if client gave player direct URL,
browser/MediaPlayer **can't start or seek** until downloading to file tail —
moov is MP4 "table of contents".

## 4. How much data really needed before first frame

- **Currently:** full scene bundle ≈ **43.6 MB video + ~5.5 MB IU (5×~1.1 MB) +
  0.25 MB audio ≈ 49 MB**. Not one byte less — everything complete, before first
  frame.
- **With proper scheme (faststart + Range):** `ftyp+moov ≈ 20 KB` + first
  ~1–2s of samples (≈ 0.7–1.4 MB at 5.47 Mbps) ≈ **~0.1–1 MB**. For seek in
  middle of scene — only byte range around target (couple hundred KB).

## 5. Why navigation after first load is fast

Because **network no longer participates**:

- Within same scene: file already fully in memory/disk; web reuses
  same blob-URL and just does `currentTime = …` (`playVideoOverlay` skips
  re-src by scene key); Android — `seekTo(..., SEEK_CLOSEST)` on local
  file.
- Other scenes: `preloadAhead(3)` preloads up to 3 scenes; web additionally —
  Cache API (blobs survive `executePendingSeek`, which only clears
  in-memory `preloadCache`); Android — LruCache + disk Repository cache (its
  `executePendingSeek` doesn't clear).
- `preload`/`buffering` settings don't affect first load speed — nowhere to apply
  when source is local blob/file.

## 6. What optimizations are possible

### 6.1 moov atom relocation (faststart)

**Impact: HIGH. Enables progressive download and seeking.**

Move moov to file start during merge on backend:

```bash
ffmpeg -i input.mp4 -c copy -movflags +faststart output.mp4
```

Or apply during `concatVideos` merge step. This enables:
- Browser can start playing before full download
- MediaPlayer can seek without full file download
- Reduces first-frame time from ~49 MB to ~0.1–1 MB

### 6.2 Range requests

**Impact: MEDIUM. Enables seeking without full download.**

Add Range header support:
- Web: `fetch` with `Range: bytes=0-` header
- Android: Retrofit with `@Streaming` + OkHttp Range

Requires backend to support Range requests for video files.

### 6.3 Progressive loading

**Impact: MEDIUM. Overlaps with faststart + Range.**

Start playback as soon as moov + initial frames available:
- Web: `preload="metadata"` instead of `preload="auto"`
- Android: `MediaPlayer` with `prepareAsync()` instead of `prepare()`

### 6.4 Preload optimization

**Impact: LOW. Doesn't affect first load.**

Current `preloadAhead(3)` already works. Could reduce to `preloadAhead(2)` to save memory.

## 7. Recommended implementation order

1. **Faststart** (backend merge step) — highest impact, simplest change
2. **Range requests** (backend + frontend) — enables proper seeking
3. **Progressive loading** (frontend only) — overlaps with above
4. **Preload tuning** — lowest priority, existing works fine

## 8. Files to modify

### Backend (faststart)
- `backend/src/video/video-merge.js` — add `-movflags +faststart` to ffmpeg command
- Or `backend/src/video/video-workflows.js` — add post-processing step

### Web Frontend (Range + progressive)
- `frontends/app/src/api/client.ts` — add Range header support
- `frontends/app/src/state/playbackStore.ts` — start playback before full download

### Android Frontend (Range + progressive)
- `frontends/android/.../Repository.kt` — add Range header support
- `frontends/android/.../PlaybackViewModel.kt` — progressive loading

## 9. Risk assessment

- **Faststart:** Low risk. Simple ffmpeg flag, no behavioral change for existing clients.
- **Range requests:** Medium risk. Backend must support Range headers; nginx config needed.
- **Progressive loading:** Medium risk. UI state management changes; error handling for incomplete downloads.

## 10. Future considerations

- **Adaptive bitrate streaming (HLS/DASH):** Long-term solution for variable network conditions. Requires backend transcoding pipeline.
- **Edge caching:** CDN with Range support for video files.
- **Prefetch hints:** Server-sent `Link` headers for next scene's video.
