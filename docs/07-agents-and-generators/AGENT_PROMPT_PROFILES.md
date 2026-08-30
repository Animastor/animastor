# Prompt Profiles — Architecture & Implementation Plan

## 1. Problem

Currently all prompt construction rules are hardcoded in `backend/src/services/agent-prompts.js`
as `SYSTEM_PROMPTS` constants. This creates several problems:

- **LTX-specific knowledge** in `video_action_reconciliation` and `video_action_polish`
  (rules about reference image, temporal vs static) is hardcoded in JS.
- Adding new model (Veo, V1, Kling, Wan) requires changing agent code.
- Can't have different prompting versions for same model (ltx-2.3 vs ltx-2.4).
- Prompting knowledge distributed between JS string and documentation — no single source of truth.

## 2. Solution: Prompt Profiles

**Prompt Profile** is a set of prompting rules for specific model, stored
as markdown file in `backend/ai/skills/`.

### Principle

```
Workflow (ComfyUI JSON) → selects model
       ↓
Connector (JSON) → contains profile: "ltx-2.3"
       ↓
Skill file (backend/ai/skills/video/ltx-2.3.md) → prompting rules
       ↓
Agent Pipeline — before prompt generation reads corresponding Skill
                  and uses its recommendations
```

### Skills structure

```
backend/ai/skills/
├── video/
│   ├── ltx-2.3.md          # LTX 2.3 Image-to-Video prompting rules
│   ├── ltx-2.4.md          # (future) LTX 2.4 prompting rules
│   ├── veo.md              # (future) Veo prompting rules
│   └── kling.md            # (future) Kling prompting rules
├── image/
│   ├── qwen-image.md       # Qwen Image prompting rules
│   ├── flux.md             # (future) Flux prompting rules
│   └── sdxl.md             # (future) SDXL prompting rules
├── audio/
│   ├── qwen-tts.md         # Qwen TTS prompting rules
│   └── fish-speech.md      # (future) Fish Speech prompting rules

> There is NO `default` profile/skill — only real model profiles. If profile
> not set (neither override nor connector), skill not injected, assembly uses
> built-in fallback in `assembly-profile.js`.
├── (existing general skills)
│   ├── camera_language.md
│   ├── composition.md
│   ├── continuity.md
│   ├── directing.md
│   ├── entity_extraction.md
│   ├── lighting.md
│   ├── prompt_engineering.md
│   └── storyboard.md
```

### Profile types

| Type | Purpose | Examples |
|---|---|---|
| `videoProfile` | Rules for `video.action` | `ltx-2.3`, `veo`, `kling` |
| `imageProfile` | Rules for `image.prompt` | `qwen-image`, `flux` |
| `audioProfile` | Rules for `audio.*` | `qwen-tts`, `fish-speech` |

## 3. Connector Changes

Each connector (in `backend/ai/connectors/`) gets `profile` field indicating
which prompting profile matches its workflow:

```json
{
  "connectorVersion": "1.0.0",
  "workflow": "video-ltx-1p",
  "type": "video",
  "profile": {
    "videoProfile": "ltx-2.3"
  },
  ...
}
```

### Connector → profile mapping

| Connector | type | profile |
|---|---|---|
| `conn-video-1p` | video | `{ "videoProfile": "ltx-2.3" }` |
| `conn-video-2p` | video | `{ "videoProfile": "ltx-2.3" }` |
| `conn-video-3p` | video | `{ "videoProfile": "ltx-2.3" }` |
| `conn-video-4p` | video | `{ "videoProfile": "ltx-2.3" }` |
| `conn-image-generation` | image | `{ "imageProfile": "qwen-image" }` |
| `conn-tts-dialogue` | audio | `{ "audioProfile": "qwen-tts" }` |
| `conn-tts-narration` | audio | `{ "audioProfile": "qwen-tts" }` |

## 4. Agent Pipeline Changes

### 4.1 Skill loading

Before prompt generation, pipeline reads corresponding skill file:

```javascript
// In pipeline-steps.js:
const skillContent = await loadSkill(connector.profile.videoProfile || connector.profile.imageProfile);
```

### 4.2 Skill injection

Skill content injected into system prompt as additional context section:

```javascript
const systemPrompt = `${basePrompt}\n\n## Model-specific rules\n${skillContent}`;
```

## 5. Implementation Steps

### ✅ Step 1: Create skill files
- `backend/ai/skills/video/ltx-2.3.md` — extracted from hardcoded rules
- `backend/ai/skills/image/qwen-image.md` — extracted from hardcoded rules
- `backend/ai/skills/audio/qwen-tts.md` — extracted from hardcoded rules

### ✅ Step 2: Update connectors
All 7 connectors updated with `profile` field.

### ✅ Step 3: Update pipeline
`pipeline-steps.js` reads skill files and injects into prompts.

### ✅ Step 4: Remove hardcoded rules
`agent-prompts.js` cleaned of model-specific knowledge.

## 6. Benefits

- **Model independence:** Adding new model = create new skill file, update connector
- **Version control:** Each skill file independently versioned
- **Single source of truth:** All prompting rules in `backend/ai/skills/`
- **Easy testing:** Skills can be tested independently

## 7. Future Extensions

- **Dynamic skill loading:** Skills loaded at runtime based on model capabilities
- **Skill composition:** Combine multiple skills for complex prompts
- **A/B testing:** Different skill versions for same model
- **Community skills:** User-contributed skills for custom models
