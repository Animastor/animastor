# Summary of Changes

## Backend Fixes
- **Bootstrap Logic**: During TXT bootstrap, chunk creation in Redis now includes `scene_type`, `scene_id`, and `chapter_id`.
- **API Responses**: Updated `/api/v1/chunk/:id` and `/api/v1/chunk/:id/storyboard` to include `scene_type`.
- **Placeholder Audio**: Synchronized placeholder audio generation to ensure files are ready before HTTP response.

## Frontend Fixes
- **GenerateViewModel**: 
    - Updated `importTxtFromFile` and `importText` to use `getAllChunks(bId)` for consistent retrieval of real chunk IDs.
    - Persisted `buildId` as `"default"` instead of empty string.
    - Correctly build `chunkPositions` map from storyboard data.
- **PlaybackViewModel**:
    - Introduced `windowGenInProgress` and `STRUCTURAL_SCENE_TYPES` for precise window generation triggering.
    - Updated `checkAndTriggerWindowGeneration()` to calculate content-only window index, ensuring structural scenes (cover, chapter_intro) are excluded.
    - Added `inProgress` status to `WindowGenStatus`.
    - Added `_chunkSceneTypes` mapping for tracking scene types.
- **MainActivity**:
    - Updated progress bar logic to observe `inProgress` flag, preventing UI flickering.

## Diagnostics
- **Issue**: Player showing IDLE after TXT import, despite successful book creation.
- **Root Cause Analysis**: Verified Redis state and chunk creation via direct inspection. Confirmed API route `/api/v1/book/:bookId/chunks` is correct and matches frontend calls. 
- **Next Steps**: Continued investigation into `playbackPrepared` flow to ensure UI collector captures the emission correctly after bootstrap.
