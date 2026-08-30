# Generators: Animastor

## Overview

In the Animastor project, the term "generator" as a formal abstraction (base class Generator, interface IGenerator, generator factory) **was not found**. Generation is implemented through **services** (`audio/`, `image/`, `video/`) that use **workflow builders** to create ComfyUI-compatible JSON and send them to **GPU Hub** via **gpu-dispatcher**.

## Generation Types

### Audio Generator (`backend/src/audio/audio-service.js`)

**Connection:** Module connected via `require('./audio')` in backend.cjs. Exports `generateSceneAudio()`, `mergeAllAudio()`, `isSceneAudioReady()`, `trimPaddedSceneAudio()`, `generateSilentAudio()`.

**Interface:**
```js
async generateSceneAudio(redis, sceneData, loadedBook, buildId, bookId)
async mergeSceneAudioChunks(redis, bookId, chapterId, sceneId, buildId, expectedCount)
async mergeAllAudio(buildId, bookId, sceneCount)
async isSceneAudioReady(buildId, bookId, chapterId, sceneId)
async trimPaddedSceneAudio(audioPath)
async generateSilentAudio(audioPath, durationSec)
```

**Implementation details:**
- Splits scene text into narration/dialogue segments
- For narration: `tts-qwen-narrator` workflow
- For dialogue: `tts-qwen-dialogue` workflow (two voices)
- Uses `ffmpeg` for audio chunk merging
- Silent trimming after generation
- Padded text trimming (removing duplicated audio for short texts)
- Placeholder audio (silence) if real TTS not yet ready

---

### Image Generator (`backend/src/image/image-service.js`)

**Interface:**
```js
async generateSceneIUImages(redis, sceneData, loadedBook, buildId, bookId)
async buildImagePrompt(iuPayload, scenePayload, chapterPayload, bookPayload)
async resolveCanonicalSceneImage(outputDir, buildId, bookId, chapterId, sceneId)
```

**Implementation details:**
- Prompts built from: character appearance + location + IU description
- **`buildImagePrompt()`** — assembles final prompt from multiple sources:
  `resolveVisualStyle()`, `resolveLocationFromPrompt()`, `inferCharactersFromPrompt()`
- **`resolveVisualStyle()`** — chain: IU→scene→root style (with typography filter)→bible style
- **`resolveLocationFromPrompt()`** — if scene has no `location.id`, matches
  prompt text with `bible.locations` via Cyr→Lat transliteration + prefix matching
- **`inferCharactersFromPrompt()`** — **primary mechanism** for determining frame
  participants (since July 2026; `unit.participants` removed). Scans `visual.prompt` for
  `character_id` and injects passports from `characters.json`.
- Support for `epoch`, `season`, `atmosphere` from `scene.location.environment`
- `locations.json` contains global `environment` template (time/season/lighting/weather/
  mood/atmosphere) — fallback for scenes. `scene.location.environment` overrides it per-field
  (character passport pattern); merge performed in `buildImagePrompt()` and video builder
- **Scene-level passport overrides** (`scene.passport[charId]`): `resolvePassport()`
  takes scene override (appearance, clothes) with highest priority over global character passport;
  uncovered fields from `characters.json`. Similarly video builder reads
  `scene.passport[id].video_tokens` with priority over global. Changing `scene.passport`
  marks scene for image+video regeneration (`prompt-dependency-registry.js`,
  `SCENE_FIELDS`).
- **Global passport** (`characters.json` → `passport`): two fields — `appearance`
  (physical appearance, WITHOUT clothing) and `clothes` (clothing/accessories) + `video_tokens`.
  Appearance and clothing separation done by AGENT (`ai/rules/characters.md` — separate fields,
  both in English); program (`lazy-book/create.js`) only validates result and
  fills safe defaults, no regex heuristics. Final character string:
  `"id: appearance, clothes"` — no duplicates.
- **Video tokens — two-stage agent scheme**: `passport.video_tokens` — array of 1–4
  short, most noticeable visual features (tie, glasses, baldness, red
  jacket...) that video model latches onto in reference image.
  - Stage 1 — agent (`ai/rules/characters.md`) selects features when creating passport
    (soft instruction, field optional); program only sanitizes list (trim,
    ≤4) and falls back to regex fragment (`fragmentAppearanceForVideo`).
  - Stage 2 — `passport_reconciliation` receives each scene's participants with current
    tokens and passports, compares tokens between scene participants and on collision
    re-selects features (only from passport); result written to
    `scene.passport[charId].video_tokens` (only when different from current) and picked up
    by video builder with priority over global. Uniqueness checked only for
    scenes with ≥2 participants.
  - `video-workflows` joins array with commas (accepts legacy string) and guards
    against exact token duplicates within scene (second participant falls to global token).
- Caching: if image already exists — skipped
- Uses `img-qwen-image` workflow
- Parallel IU submission via GPU Hub

---

### Video Generator (`backend/src/video/video-service.js`)

**Interface:**
```js
async generateVideoAnimation(sceneData, loadedBook, buildId, workflows)
async validateVideoFile(videoPath)
async updateSceneVideoStatus(redis, bookId, chapterId, sceneId, status)
```

**Implementation details:**
- IU grouping: maximum 4 images per group (LTX limitation)
- Workflow selection: `video-ltx-1p`, `2p`, `3p`, `4p` by IU count in group
- FPS: 24, frame alignment: 8n+1 (LTX requirement; alignment step and trim/keyframe-forcing requirement set by video profile — see AUDIO_VIDEO_SYNC.md)
- Video prompt includes: characters, timecode, environment (from book.bible)
- Returns `jobSpecs` for GPU Hub submission

---

### AI Text Generator (`backend/src/services/ai-service.js`)

**Interface:**
```js
async callAI(model, messages, options)       // general API call
async parseJsonResponse(text)                // JSON parsing from response
async refineDraft(chapterText)               // full AI analysis with examples
```

**Implementation details:**
- Timeout: 60s (default) / 180s (refineDraft) / 180s (agent-service)
- Retries: 3 (backoff: 1s, 2s, 4s)
- Supports OpenRouter and Nvidia API (via AI_API_BASE_URL)
- `refineDraft()` loads examples from `ai/examples/` and includes in prompt
- Not abstracted: model set by string, no provider factory

---

### Placeholder Audio Generator (`backend/src/services/placeholder-audio.js`)

**Interface:**
```js
async ensurePlaceholderAudio(buildId, bookId, chapterId, sceneId)
async ensureAllPlaceholderAudio(buildId, bookId, scenes)
async hasRealAudio(bookId, chapterId, sceneId, buildId)
async replacePlaceholderWithRealAudio(bookId, chapterId, sceneId, buildId, realAudioPath, realDuration)
async recoverMissingPlaceholders(buildId, bookId)
```

**Result format:**
- MP3 silence files (duration matching scene — by IU or text)
- Registration in PostgreSQL scene_assets with status 'placeholder'
- Replacement with real audio on TTS completion (via `replacePlaceholderWithRealAudio`)

---

## Common Generator Abstraction Layer

**No formal abstraction layer found.** Each generator:
- Has its own interface (different function names, different parameters)
- Uses different workflows (audio/image/video)
- Processes results differently (audio → MP3 merge, Image → PNG cache, Video → group merge)

However, all generators follow a common pattern:
1. Get scene data
2. Build workflow (via workflow builder)
3. Call `gpu.send()` / `gpu.sendVideo()` / `gpu.sendUnified()`
4. Process callback via task-handler
5. Save result to disk + register in asset registry (PostgreSQL)

### Can any generator be replaced without changing the rest of the system?

**No, replacing any generator without changing the rest of the system is impossible.** Reasons:

1. **Unique interfaces:** Each generator has its own parameter set and return values. No common contract.

2. **Hard coupling with type system:** Orchestrator, dispatch-engine, scene-state have hardcoded references to `'audio'`, `'image'`, `'video'`.

3. **Specific workflow builders:** Each generation type uses its own workflow set with different Node IDs.

4. **Different result processing:** Audio → chunk merge + padded text trim, Image → PNG caching + IU completion check, Video → group merge + mux with audio.

5. **Hard layer binding:** Layer config explicitly lists `audio`, `image`, `video` as keys.

6. **Dispatch engine hardcoded:** Quota, lease TTL, circuit breaker thresholds — all tuned for these three types.

**Replacement would require:**
- Refactoring orchestrator to work through abstract generator interface
- Creating generator registry
- Adding new type to dispatch-engine, layer-config, scene-state (AssetState)
- New workflow builder + templates
- Updating GPU Hub and worker to support new job_type
