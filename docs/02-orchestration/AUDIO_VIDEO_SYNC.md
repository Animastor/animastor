# Audio and Video Synchronization (Raw Audio Chunks = Source of Truth)

> Status: implemented (2026-08-13), verified on real scene run
> `sc-45d38693`. Research and rationale — see history below.

## Problem

Synchronizing a scene's audio track with the video track assembled from video chunks
depended on **predicted** unit timings (Postgres `image_units`), which were calculated
proportional to text length. Actual speech deviates from the prediction:

- per-unit drift: **up to ±0.77 s**;
- cumulative drift by end of scene: **up to +0.64 s** (video lags/leads speech).

## Solution: Actual Raw Chunk Durations

Architectural chain:

```
raw audio chunks ──ffprobe──► .chunk-durations.json {chunk_index, unit_id, raw, tail}
                                     │
                                     ▼
                     IU-RECALC: per-unit grouping (raw, except last → tail)
                                     │
                                     ▼
                     PG image_units: start_ms/end_ms/estimated_duration_sec (actual)
                                     │
                                     ▼
                     video-workflows: reads actual timings → video chunks
```

### Key Components

| Component | Location | What It Does |
|---|---|---|
| `unit_id` in segments | `backend/src/audio/segments.js` | Each TTS segment (= chunk) knows its unit: dialogue — directly, narration — `assignNarrationUnitIds` (position-based mapping in text) |
| `unit_id` in Redis | `backend/src/audio/generation.js` + `redis-helpers.cjs` (`saveChunk`) | Passed to `animastor:chunk:*` key on creation **and on every chunk receipt** (bug: `saveChunk` overwrote the key with a fixed field set, erasing `unit_id` — fixed) |
| Duration measurement | `backend/src/audio/pipeline.js` (`trackChunkDurations`) | Before merge, each chunk is measured by ffprobe: `raw_duration_sec` (as on disk) and `tail_duration_sec` (after tail-only trimming); writes `<scene>.chunk-durations.json` next to merged file |
| Unit timing update | `backend/src/orchestration/scene-callbacks.js` (IU-RECALC) | Instead of proportional split — cumulative actual `start_ms/end_ms` + `estimated_duration_sec`; proportional split remains only as fallback (no per-chunk data) |
| Consumer | `backend/src/workflows/video/video-workflows.js` (`readIUMetadata`) | Video workflow reads actual `estimated_duration_sec` from PG — no changes needed |

### Tail Correction for Last Chunk

Cleanup trims trailing silence only for the **last** chunk of a scene (trails of
intermediate chunks become internal pauses and are preserved during concat). Therefore
for perfect alignment with the merged file:

- chunks 1..N−1 — by `raw_duration_sec`;
- last chunk — by `tail_duration_sec`.

Result on `sc-45d38693`: Σ unit timings = **63.720 s** = merged file
duration (Δ = 0.000).

### Post-Run Verification (2026-08-13, `sc-45d38693`)

| Unit | Before (proportional) | After (actual) | Video actual | Δ video−audio |
|---|---|---|---|---|
| iu-5a1befa0 | 7.314 | 7.656 | 7.708 | +0.052 |
| iu-bff1a5bc | 15.614 | 15.264 | 15.375 | +0.111 |
| iu-b1801ef9 | 11.042 | 11.808 | 12.042 | +0.234 |
| iu-73ef8ccb | 21.170 | 20.616 | 20.708 | +0.092 |
| iu-bfea502d | 8.580 | 8.376 (tail) | 8.375 | −0.001 |

Boundary deviations dropped from **±0.28…0.77 s** to **±0.00…0.23 s** — this is pure
frame quantum (24 fps) + LTX alignment, without systematic offset.

## Residual Drift: Per-Chunk LTX Alignment

LTX 2.3 requires frame count = **8n+1** (official table: 9, 17, 25, 33…).
Each video chunk pays an "alignment tax" (rounding total frames up to
8n+1). If each unit is a separate chunk, the tax is paid N times.

- Old scheme (5 chunks × 1 unit): tax **+12 frames = +0.488 s** per scene.
- New scheme — `selectWorkflowGroups` (DP optimization in `video-workflows.js`):
  minimizes total tax with constraints (≤ 4 units per group, ≤ 30 s per
  group, soft penalty for exceeding 20 s). On `sc-45d38693` selected
  `[1][2+3][4][5]` → tax **+3 frames = +0.125 s**.

DP accounts for the fact that group frame sum may already be 8n+1 (zero tax):
e.g., `15.264 + 11.808 s` → 649 frames = 8×81+1.

## Eliminating Tax at Merge (Profile-Aligned Trimming)

The alignment tax remains in the source group chunks (`_gN.mp4`), but during
scene merge each chunk is **trimmed to exact audio frame count**
(`alignGroupClips` → `trimVideoToFrames`, frame-exact `-c copy` + faststart), and
keyframes are forced at unit boundaries (`forceKeyframesAtUnitBoundaries`).
The final merged scene file = sum of raw frames = audio timeline (Δ → 0 frames).

Behavior is controlled by the **video profile** (`ai/profiles/video/{profile}.json`,
`video` section):

| Property | ltx-2.3 | Purpose |
|---|---|---|
| `frameAlignment` | `8` | Valid frame count step (8n+1 for LTX); sets matching and trim targets |
| `requiresTrim` | `true` | Whether to trim chunks to exact audio frames at merge |
| `requiresKeyframeForcing` | `true` | Whether to force keyframes at unit boundaries |

The resolver `resolveVideoProfileMeta()` (`video-merge.js`): user
override → connector default (`profile.videoProfile`) → `null`. With
`null` profile, previous behavior is preserved (trim proceeds; for chunks with exact
frame count it's a no-op: target equals actual frame count, file untouched).

Book export (`mergeBookVideosFromSources`) follows the same path: chunks are
trimmed, unit boundaries forced at SOURCE bitrate (not playback).
Single-group scenes are aligned the same way so book timeline matches
audio.

## Environment (Research Flags)

| Variable | Purpose |
|---|---|
| `KEEP_AUDIO_CHUNKS=1` | Don't delete raw chunks after merge (primary timing source + debugging) |
| `AUDIO_CLEANUP_TAIL_ONLY=1` | Cleanup trims only trailing silence, internal pauses preserved |
| `TRACK_CHUNK_DURATIONS=1` | Measure chunk durations in `.chunk-durations.json` during merge |

## History

- **2026-08-13** — research: first run showed mechanism didn't
  fire — `unit_id` was erased in `saveChunk` (`redis-helpers.cjs`). Fixed,
  re-run confirmed the full chain: Redis → JSON → PG → video.
- **2026-08-13** — LTX grouping: `selectWorkflowGroups` rewritten with DP,
  alignment tax reduced from +12 to +3 frames per scene.
