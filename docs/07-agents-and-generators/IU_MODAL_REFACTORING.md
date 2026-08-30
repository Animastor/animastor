# IU Modal Refactoring: Audio / Image / Video

> **Date:** 2026-07-12
> **Basis:** ChatGPT sketch + full current architecture audit
> **Status:** Phase 1 (Audio) ✅ | Phase 2 (Image) ✅ | Phase 3 (Video) ✅ | Phase 4 (Frontend) ✅ | Phase 5 (Cleanup) ✅ | Phase 6 (Agent prompts) ✅ | Phase 7 (Visual removal) ✅

---

## 1. Current architecture audit

### 1.1 Original IU structure (before refactoring)

```json
{
  "id": "iu-38d6e6ea",
  "type": "perception",
  "text": "content...",
  "speaker": "bezdomny",
  "visual": { "shot": "medium", "prompt": "...", "negative": "" }
}
```

### 1.3 Final IU structure (after refactoring)

```json
{
  "id": "iu-38d6e6ea",
  "type": "perception",
  "text": "content...",
  "audio": { "speaker": "bezdomny", "text": "..." },
  "image": { "shot": "medium", "prompt": "...", "negative": "" },
  "video": { "action": "..." }
}
```

`visual`, `speaker` (top-level) fields — **removed** from entire system.

### 1.2 Key problems (resolved)

1. **`visual.prompt` — one for everything** — split into `image.prompt` + `video.action`
2. **`unit.text` — dual purpose** — `audio.text` now canonical source
3. **No precise dirty logic** — `video.action` → video only (not image)
4. **Video prompt built from image prompt** — now `video.action` + derived speaker
5. **`speaker` lost on save** — fixed

---

## 2. Target IU architecture ✅

```typescript
interface ImaginationUnit {
  id: string;
  type: "perception" | "dialogue" | "narration" | "typography" | "description" | "action" | "transition";

  participants?: string[];

  // ─── Phase 1: Audio ✅ ──────────────────────────
  audio?: {
    text: string;
    speaker?: string;
  };

  // ─── Phase 2: Image ✅ ──────────────────────────
  image?: {
    shot?: "wide" | "medium" | "close" | "detail" | "environment" | "reaction";
    prompt: string;
    negative?: string;
    character_binding?: boolean;
    style?: string;
    lighting?: string;
    quality?: string;
  };

  // ─── Phase 3: Video ✅ ──────────────────────────
  video?: {
    action?: string;
    camera?: string;
    negative?: string;
  };
}
```

### 2.1 Derived information (system does NOT duplicate)

| Data | Source | Derived for |
|---|---|---|
| Active video speaker | `type=dialogue` + `audio.speaker` | "speaking with lip movement" |
| IU participants | `participants` or `scene.participants` | Passport injection |
| IU duration | `audio.text` → word count | Timing, video frames |
| Character binding | `participants?.length > 0` | Passport injection |

---

## 3. Phase 1: Audio ✅

| File | Change |
|---|---|
| `backend/src/audio/segments.js` | `buildSegments()` reads only `audio.speaker` / `audio.text` |
| `backend/src/services/agent/pipeline-steps.js` | `stepCreateUnits()` writes `audio: { speaker, text }` |
| `backend/src/book/lazy-book/create.js` | `speaker` and `audio` saved in JSON |
| `backend/src/image/iu-processor.js` | IU duration from `audio.text` |
| `backend/src/services/prompt-dependency-registry.js` | `u.audio` dirty detection |
| `backend/src/services/agent/pipeline-runner.js` | `audio` field through reconciliation/polish |

---

## 4. Phase 2: Image ✅

| File | Change |
|---|---|
| `backend/src/image/prompt-builder.js` | `resolveImageField()` reads `image.*` with fallback `visual.*` |
| `backend/src/services/agent/pipeline-steps.js` | `stepCreateVisuals()` dual-writes `image: { shot, prompt }` |
| `backend/src/services/agent/pipeline-steps.js` | Reconciliation & polish update `image.prompt` |
| `backend/src/services/agent/pipeline-runner.js` | Reverse mapping reconciliation/polish → `unit.image` |
| `backend/src/book/lazy-book/create.js` | Saves `image` field to JSON |
| `backend/src/workflows/video/video-workflows.js` | Reads `image.*` with fallback `visual.*` |
| `backend/src/services/prompt-dependency-registry.js` | `u.image` dirty detection + knownUnitKeys |

---

## 5. Phase 3: Video ✅

| File | Change |
|---|---|
| `backend/src/services/agent/pipeline-steps.js` | `stepCreateVisuals()` dual-writes `video: { action }` |
| `backend/src/services/agent/pipeline-steps.js` | Reconciliation & polish update `video.action` |
| `backend/src/services/agent/pipeline-runner.js` | `video` mapping via reconciliation/polish |
| `backend/src/book/lazy-book/create.js` | Saves `video` field to JSON |
| `backend/src/workflows/video/video-workflows.js` | `video.action` as temporal description + derived speaker from `audio.speaker` |
| `backend/src/services/prompt-dependency-registry.js` | `u.video` tracking: video.action → video only (not image) |

---

## 6. Architecture Data Flow (final state)

```
AI pipeline (stepCreateUnits)
  → unit.audio = { speaker, text }     // canonical TTS source

AI pipeline (stepCreateVisuals)
  → unit.image = { shot, prompt, style, negative }   // static composition
  → unit.video = { action }                          // temporal change

buildSegments()
  → reads unit.audio.speaker + unit.audio.text
  → builds TTS script

buildImagePrompt()
  → reads unit.image.*
  → assembles final image prompt

buildVideoPrompt()
  → reads unit.video.action || unit.image.prompt
  → adds derived speaker: "X speaking with lip movement"
  → assembles storyboard for LTX

prompt-dependency-registry
  → u.audio → dirty audio only
  → u.image → dirty image + video
  → u.video → dirty video only
```

---

## 7. Changelog

| Date | Commit | Description |
|---|---|---|
| 2026-07-12 | `d5d59a4` | **Phase 1: Audio** — `unit.audio` field |
| 2026-07-12 | `32c2bc9` | **Phase 2: Image** — `unit.image` field |
| 2026-07-12 | `9f9f571` | **Phase 3: Video** — `unit.video` field + derived speaker |
| 2026-07-12 | `6cc78fd` | **AI Examples** — updated for new format |
| 2026-07-12 | `dd4237d` | **Phase 4: Frontend** — AudioSection/ImageSection/VideoSection data classes, EditFragment UI |
| 2026-07-12 | `0e836b0` | **Phase 5: Cleanup** — removed legacy visual.*/text/speaker fallbacks |
| 2026-07-12 | `2473e83` | **Phase 6: Agent prompts** — AI writes image/video/audio directly |
| 2026-07-12 | `b919a06` | **Phase 7: Visual removal** — `visual` field removed from all code and JSON |

---

## 8. Remaining phases

### Phase 4: Frontend ✅
- [x] `BookModels.kt` — AudioSection/ImageSection/VideoSection data classes, SceneUnit updated
- [x] `EditFragment.kt` — modal editing UI: readUnitField/buildUnitFields/applyFieldValues
- [x] `strings.xml` — string resources for sections (Audio/Visual/Image/Video)

### Phase 5: Legacy cleanup ✅
- [x] `prompt-builder.js` — `resolveImageField()` reads only `image.*`; `resolveVisualStyle` without `visual.style`; `resolveNegativePrompt` without unit-level legacy
- [x] `video-workflows.js` — `buildVideoPrompt()` without `visual.*` fallbacks
- [x] `prompt-dependency-registry.js` — removed `oldU.text/content/visual`; `knownUnitKeys = ['id', 'type', 'audio', 'image', 'video']`
- [x] `pipeline-steps.js` — completed dual-write: added `image.style`/`image.negative` in all passes
- [x] Tests: `coreference-image.test.js`, `video-workflows.test.js`

### Phase 6: Agent prompts ✅
- [x] `SYSTEM_PROMPTS.visuals` — AI writes `image` + `video` instead of `visual`
- [x] `SYSTEM_PROMPTS.units` — AI writes `audio.speaker`/`audio.text` instead of `text`/`speaker`
- [x] `passport_reconciliation`, `storyboard_polish` — output format `image` instead of `visual`
- [x] `stepCreateVisuals` — reads `image`/`video` from AI
- [x] `stepCreateUnits` — reads `audio` from AI
- [x] `dryrun-visuals-iu.js` — updated for `image`/`video` format

### Phase 7: Complete visual removal ✅
- [x] `visual` field removed from `pipeline-steps.js` (stepCreateVisuals, reconciliation, polish)
- [x] `visual` field removed from `pipeline-runner.js` (reconciliation/polish mapping)
- [x] `visual` field removed from `chapter-utils.js` (chapter_intro, cover scenes)
- [x] `visual` field removed from `create.js` (unit serialization)
- [x] `visual` → `image` in `ai-service.js` (system prompt + validation)
- [x] `visual` special handling removed from `scene-hash.js`
- [x] `visual-utils.js` → `image-utils.js` (rename + functions renamed)
- [x] Dead code removed: dual-write `speaker/text↔audio`, unused imports, `u.speaker` checks
- [x] `visual` removed from `ai/examples/*.json` (3 files, 22 occurrences)
- [x] `VisualConfig`, `VisualConfigAdapter`, `SceneUnit.visual` removed from `BookModels.kt` (Android)

---

## 9. Key files

### Backend Core:
- `backend/src/book/index.js`
- `backend/src/book/lazy-book/create.js`
- `backend/src/image/prompt-builder.js`
- `backend/src/image/iu-processor.js`

### Agent Pipeline:
- `backend/src/services/agent-prompts.js`
- `backend/src/services/agent/pipeline-steps.js`
- `backend/src/services/agent/pipeline-runner.js`
- `backend/src/services/agent/image-utils.js`
- `backend/src/services/ai-service.js`

### Dependencies:
- `backend/src/services/prompt-dependency-registry.js`
- `backend/src/dependency-graph.js`

### Audio:
- `backend/src/audio/segments.js`

### Video:
- `backend/src/workflows/video/video-workflows.js`

### Frontend:
- `frontend/.../BookModels.kt`
- `frontend/.../EditFragment.kt`
