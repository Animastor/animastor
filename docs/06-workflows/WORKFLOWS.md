# Workflows: Animastor

## Overview

Workflows in Animastor are JSON templates compatible with ComfyUI that define GPU processing pipelines for audio, image, and video generation. Workflows are loaded from `.json` files in the `/app/ai/workflows/` directory at backend startup.

## Workflow Types

| Type | Template File | Purpose |
|-----|-------------|---------|
| `tts-qwen-narrator` | `backend/ai/workflows/tts-qwen-narrator.json` | TTS narration (single voice) |
| `tts-qwen-dialogue` | `backend/ai/workflows/tts-qwen-dialogue.json` | TTS dialogue (two voices) |
| `img-qwen-image` | `backend/ai/workflows/img-qwen-image.json` | Image generation |
| `video-ltx-1p` | `backend/ai/workflows/video-ltx-1p.json` | Video from 1 image (LTX) |
| `video-ltx-2p` | `backend/ai/workflows/video-ltx-2p.json` | Video from 2 images (LTX) |
| `video-ltx-3p` | `backend/ai/workflows/video-ltx-3p.json` | Video from 3 images (LTX) |
| `video-ltx-4p` | `backend/ai/workflows/video-ltx-4p.json` | Video from 4 images (LTX) |

## Build Mechanism

### Workflow Loader (`backend/src/workflows/workflow-loader.js`)

1. At backend startup, scans `/app/ai/workflows/*.json`
2. Each file is loaded as a named template: `workflows[filenameWithoutExt] = template`
3. API: `getWorkflow(name)` → returns a **deep clone** of the template (`JSON.parse(JSON.stringify(template))`)

### Workflow Builders

Each workflow type has its own builder module:

**Audio Workflows** (`backend/src/workflows/audio/audio-workflows.js`):
- `buildNarrationTTSWorkflow(text, voiceInstruction)` — fills text node (108) and voice instructions
- `buildDialogueTTSWorkflow(script, c1Voice, c2Voice, c1Role, c2Role)` — configures dialogue nodes (108, 71, 80, 74)
- `buildNarratorVoice(scene, book)` — extracts voice settings from book manifest

**Image Workflows** (`backend/src/workflows/image/image-workflows.js`):
- `buildImageWorkflow(prompt, negativePrompt)` — fills prompt nodes (108) and negative prompt (109)

**Video Workflows** (`backend/src/workflows/video/video-workflows.js`):
- `buildVideoWorkflows(sceneData, loadedBook, buildId, workflows)` — main entry point
- `selectWorkflowGroups(unitCount)` — selects templates (1p/2p/3p/4p) based on IU count
- `calculateFrames(iuDurations)` — calculates frame indices with alignment (8n+1 for LTX; alignment step set by video profile, see AUDIO_VIDEO_SYNC.md)
- `buildVideoPrompt(sceneData, loadedBook, units, iuDurations)` — assembles prompt with characters, time, environment
- `buildVideoNegativePrompt(sceneData, units)` — assembles negative prompt

## Execution Mechanism

1. **Service calls builder** → gets ready JSON workflow
2. **Service calls `gpu.send(job_id, workflow, type, buildId)`** or `gpu.sendUnified(taskSpec)` → HTTP POST to GPU Hub (3 retries, 30s timeout)
3. **GPU Hub** enqueues task in Redis queue, deduplicates (NX EX 3600)
4. **Worker (ESM)** picks up task: first saves assets (images) to COMFY_INPUT_DIR, then sends workflow to ComfyUI (`POST /prompt`)
5. **ComfyUI** executes nodes and generates result
6. **Worker** waits for result (long polling, timeout 10 min), downloads base64 result from ComfyUI, sends to GPU Hub
7. **GPU Hub** forwards result to backend (5 retries, 500ms delay)
8. **Worker can detect video via filesystem** (scans COMFY_OUTPUT_DIR/video/ for new .mp4 files)

```
Backend Service → [buildWorkflow] → JSON
               → [gpu.send/sendUnified] → GPU Hub → Redis Queue
                                          → Worker → save assets to COMFY_INPUT_DIR
                                          → Worker → ComfyUI POST /prompt
                                          → Worker → poll /history
                                          → Worker → download result base64
                                          → GPU Hub → 5× retry → Backend Task Handler
```

## Multi-image assets

Worker supports loading multiple images for LTX video:
```
task.assets.images = {
  "unitId_1": "base64...",
  "unitId_2": "base64...",
  ...
}
```
Each image is saved as `<scenePrefix>_<unitId>.png` in COMFY_INPUT_DIR.

## Extension points

1. **New templates**: place `.json` file in `/app/ai/workflows/` → automatically loaded
2. **New builders**: add file to `backend/src/workflows/<type>/`, register in `index.js`
3. **New workflow types**: add `job_type` support in GPU Hub and Worker
4. **New workflow connection**: via `workflow-loader.getWorkflow(name)` + builder

## Workflow lifecycle

```
                         ╔══════════════════════╗
                         ║    FILE ON DISK      ║
                         ║  /app/ai/workflows/    ║
                         ╚══════════╤═══════════╝
                                    │ Startup
                                    ▼
                         ╔══════════════════════╗
                         ║   Workflow Loader    ║
                         ║ (deep clone on get)  ║
                         ╚══════════╤═══════════╝
                                    │ getWorkflow(name)
                                    ▼
                         ╔══════════════════════╗
                         ║    Template (JSON)   ║
                         ╚══════════╤═══════════╝
                                    │ builder(params)
                                    ▼
                         ╔══════════════════════╗
                         ║   Filled Workflow    ║
                         ║    (ready to send)   ║
                         ╚══════════╤═══════════╝
                                    │ gpu.send/sendUnified()
                                    ▼
                         ╔══════════════════════╗
                         ║   GPU Hub Queue      ║
                         ║   (dedup: NX EX 3600)║
                         ╚══════════╤═══════════╝
                                    │ Worker pop (poll)
                                    ▼
                         ╔══════════════════════╗
                         ║   ComfyUI Execute    ║
                         ║   (10 min timeout)   ║
                         ╚══════════╤═══════════╝
                                    │ Result
                                    ▼
                         ╔══════════════════════╗
                         ║   Task Completed     ║
                         ║   (5× retry to b/e)  ║
                         ╚══════════════════════╝
```

## Connecting a new workflow

1. Create JSON template in `/app/ai/workflows/<name>.json`
2. Restart backend (or reload workflows)
3. Create builder function (optional, for parameterization)
4. Use via `wfLoader.getWorkflow('<name>')` in the appropriate service

## Limitations

- Workflows loaded only at startup (hot-reload not supported)
- All workflows are ComfyUI-specific (not abstracted for other platforms)
- Video workflows limited: maximum 4 images per group (LTX limitation)
- GPU_TIMEOUT: 10 min (configurable via env)

## Node ID Map

**Image (img-qwen-image):**
- Node 108: positive prompt
- Node 109: negative prompt

**Audio TTS:**
- Node 108: narration text / first voice (dialogue)
- Node 71: second voice (dialogue)
- Node 80: second voice role (dialogue)
- Node 74: first voice role (dialogue)

**Video (video-ltx-*):**
- Node 112: total frames
- Node 121: positive prompt
- Node 110: negative prompt
- Nodes 149, 179, 187, 216: image loading (load image)
