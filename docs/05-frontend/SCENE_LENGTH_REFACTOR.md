# Scene Length & Video Chunking Refactoring

## Overview

Remove the hard 20–30 second scene duration constraint.
Scenes are formed by semantic content (location, time, characters, logic), not by duration.
Video chunks are assembled by total IU duration, not by image count.

## Motivation

- AI currently wastes retries on artificially splitting scenes longer than 30s
- `selectWorkflowGroups` groups IUs by 4, ignoring their `estimated_duration_sec`
- This leads to unnaturally short scenes and unnecessary AI calls
- TTS, images, and video already work independently — long scenes are not a problem

## Plan

### 1. Config — `src/services/agent-prompts.js`
- `SCENE_TARGET_SEC`: 20 → 60 (target scene duration)
- `SCENE_MAX_SEC`: 30 → 120 (maximum scene duration)
- `MAX_SCENES_PER_CHUNK`: 3 → 2 (fewer scenes, but longer)
- Fix comments and calculations (words/sec)

### 2. AI rules — `ai/rules/scenes.md`
- Remove `DURATION LIMITS — HARD REQUIREMENTS` section
- Remove all references to `%SCENE_MAX_SEC%`, `%SCENE_TARGET_SEC%`, `%SCENE_MIN_SEC%`
- Replace with a soft guideline: no more than ~2 minutes
- Keep only logical scene criteria

### 3. AI Pipeline — `src/services/agent/pipeline-steps.js`
- `stepCreateScenes`: remove duration sections in `repairHint`
- Keep only coverage validation (source coverage)
- Remove `SCENE_MAX_SEC`, `SCENE_TARGET_SEC`, `SCENE_MIN_SEC` substitutions

### 4. Pipeline Runner — `src/services/agent/pipeline-runner.js`
- Remove `findOversized` / `findUndersized`
- Remove `MAX_DURATION_RETRIES` and duration validation loop
- Remove duration-retry logic after coverage
- Keep coverage-only validation

### 5. Fallback — `src/services/agent/text-utils.js`
- `buildFallbackScenes`: update checks for new limits (120s max, 60s target)
- Remove warning on single sentence > SCENE_MAX_SEC

### 6. Video chunks — `src/workflows/video/video-workflows.js`
- Change `selectWorkflowGroups(unitCount)` → `selectWorkflowGroups(units, iuDurations)`
- New algorithm: sum IU durations until ~20 seconds accumulated
- Select workflow by number of IUs in group (1–4)
- If an IU is too long (>20s), place it alone in a group
- Update all `selectWorkflowGroups` calls:
  - `buildVideoWorkflows` — already has `iuDurations`

### 7. Tests — `tests/video-workflows.test.js`
- Update `selectWorkflowGroups` tests — now accepts durations
- Add tests for new algorithm with various duration combinations

### 8. Tests — `tests/scene-split.test.js`
- Update `SCENE_MAX_SEC` and `MAX_SCENES_PER_CHUNK` assertions
- Add test for long scene if needed

## File Change Summary

| File | Change |
|------|--------|
| `src/services/agent-prompts.js` | Update constants (TARGET 60, MAX 120, CHUNK 2) |
| `ai/rules/scenes.md` | Remove duration limits, keep logical criteria |
| `src/services/agent/pipeline-steps.js` | Remove duration repair hint |
| `src/services/agent/pipeline-runner.js` | Remove duration retry loop, unused imports |
| `src/services/agent/text-utils.js` | Falls back to updated constants — no code change needed |
| `src/workflows/video/video-workflows.js` | New `selectWorkflowGroups(units, iuDurations)` |
| `src/services/agent/bootstrap.js` | Fix missing `try {` syntax error (preexisting) |
| `tests/video-workflows.test.js` | Rewrite tests for duration-aware algorithm |
| `tests/scene-split.test.js` | Update assertions |

## Order of Implementation

1. Config (agent-prompts.js)
2. AI rules (scenes.md)
3. Pipeline steps (pipeline-steps.js)
4. Pipeline runner (pipeline-runner.js)
5. Text utils (text-utils.js) — only doc updated, code unchanged
6. Video chunks (video-workflows.js)
7. Tests (video-workflows.test.js, scene-split.test.js)
8. Run tests — 40/40 + 26/26 passed ✅

## Bootstrap Bugfix

During syntax checking of all modified files, a preexisting syntax error was found
in `src/services/agent/bootstrap.js`: the `bootstrapWithAgent` function was missing
`try {` before the try block body — only `} catch (err) {` was present.

```diff
-    // Read chunk_size from layer-config BEFORE getWindowText so the text budget matches
+    try {
+        // Read chunk_size from layer-config BEFORE getWindowText so the text budget matches
         const chunkSize = await _readChunkSize(redis, bookId);
```

## Verification

- ✅ `node -c` — syntax of all modified files is valid
- ✅ `video-workflows.test.js` — 40 passing
- ✅ `scene-split.test.js` — 26 passing
- ✅ Dead code check: no dangling imports or symbols
