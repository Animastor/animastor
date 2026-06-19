# Workflow Architecture — Animastor

> **Version:** 1.0.0  
> **Status:** Draft  
> **Last updated:** 2026-06-19

---

## 1. Overview

The Workflow system in Animastor is responsible for loading, managing, and executing ComfyUI-compatible JSON pipelines that drive GPU-based media generation (audio, image, video).

The system is evolving from a simple file-based loader to a **three-layer architecture** that separates concerns, enables UI management, and prepares for AI-assisted workflow configuration.

---

## 2. Current Architecture

### 2.1 Components

```
┌─────────────────────────────────────────────────────┐
│                   Workflow Layer                     │
│  data/workflows/*.json                              │
│  (LoadImageNode, CLIPTextEncode, KSampler, etc.)   │
└────────────────────┬────────────────────────────────┘
                     │ loads at startup
┌────────────────────▼────────────────────────────────┐
│              Workflow Loader (v2.0.0)               │
│  backend/src/workflows/workflow-loader.js           │
│  - Scans /data/workflows/*.json                     │
│  - Registers: workflows[name] = template            │
│  - Computes hashes for compatibility checks         │
│  - Returns deep clones via getWorkflow(name)        │
│  - Delegates connector init to connector-loader     │
└────────────────────┬────────────────────────────────┘
                     │ provides templates to
        ┌────────────┼────────────┐
        ▼            ▼            ▼
┌──────────────┐ ┌──────────┐ ┌──────────────┐
│ Audio        │ │ Image    │ │ Video        │
│ Workflows    │ │Workflows │ │ Workflows    │
│ (builders)   │ │(builders)│ │ (builders)   │
└──────────────┘ └──────────┘ └──────────────┘
        │              │              │
        ▼              ▼              ▼
┌─────────────────────────────────────────────────────┐
│  Audio Service  │  Image Service  │  Video Service  │
│  (audio-service.js)  (image-service.js)  (video-service.js)
└─────────────────────────────────────────────────────┘
```

### 2.2 Workflow Loader (`backend/src/workflows/workflow-loader.js`)

| Aspect | Detail |
|--------|--------|
| **File** | `backend/src/workflows/workflow-loader.js` |
| **Version** | v2.0.0 (Connector-aware) |
| **Directory** | `/data/workflows/` |
| **Filter** | `*.json` excluding `old_*` prefix |
| **Storage** | In-memory `workflows` object + `workflowHashes` map |
| **API** | `loadWorkflows()`, `getWorkflow(name)`, `getConnector(name)`, `getWorkflowHash(name)` |
| **Clone method** | `JSON.parse(JSON.stringify(template))` |

**Loading flow:**
1. Scan `/data/workflows/*.json` at startup  
2. Parse each JSON → store as `workflows[nameWithoutExt]`  
3. Compute SHA-256 hash for each workflow  
4. Load and initialize connectors via `connectorLoader.initialize(workflows)`  
5. Validate each connector against its workflow (hash check, node class check)

### 2.3 Workflow Builders

Each media type has a dedicated builder module:

| Module | File | Workflows |
|--------|------|-----------|
| Audio | `backend/src/workflows/audio/audio-workflows.js` | `tts-qwen-narrator`, `tts-qwen-dialogue` |
| Image | `backend/src/workflows/image/image-workflows.js` | `img-qwen-image` |
| Video | `backend/src/workflows/video/video-workflows.js` | `video-ltx-1p` through `video-ltx-4p` |

Each builder:
1. Gets a workflow template via `wfLoader.getWorkflow(name)`  
2. Gets the corresponding connector via `wfLoader.getConnector(name)`  
3. Applies values using `cl.setValue(wf, connector, entityKey, value)`  
4. Returns a filled workflow JSON ready for submission to GPU Hub

### 2.4 Registered Workflows

| Workflow Name | Type | File | Used By |
|--------------|------|------|---------|
| `tts-qwen-narrator` | Audio | `data/workflows/tts-qwen-narrator.json` | Narration TTS |
| `tts-qwen-dialogue` | Audio | `data/workflows/tts-qwen-dialogue.json` | Dialogue TTS |
| `img-qwen-image` | Image | `data/workflows/img-qwen-image.json` | Image generation |
| `video-ltx-1p` | Video | `data/workflows/video-ltx-1p.json` | Single-image video |
| `video-ltx-2p` | Video | `data/workflows/video-ltx-2p.json` | Two-image video |
| `video-ltx-3p` | Video | `data/workflows/video-ltx-3p.json` | Three-image video |
| `video-ltx-4p` | Video | `data/workflows/video-ltx-4p.json` | Four-image video |

---

## 3. Target Architecture

### 3.1 Three-Layer Model

```
┌───────────────────────────────────────────────────────┐
│                    Schema Layer                        │
│  backend/src/workflows/entity-schema.js               │
│                                                        │
│  Canonical dictionary of all Animastor data entities:  │
│  positivePrompt, negativePrompt, sourceImage,          │
│  generatedVideo, width, height, steps, cfg, etc.       │
│                                                        │
│  Responsibilities:                                     │
│  - Define all entity types (input/output/parameter)    │
│  - Provide human-readable labels and descriptions      │
│  - Validate entity references from connectors          │
│  - Serve as type system for UI and AI tools            │
└──────────────────────┬────────────────────────────────┘
                       │ references
┌──────────────────────▼────────────────────────────────┐
│                   Connector Layer                       │
│  backend/src/workflows/connector-loader.js             │
│                                                        │
│  Declarative bridge between backend entities and       │
│  ComfyUI workflow nodes.                               │
│                                                        │
│  Responsibilities:                                     │
│  - Load connectors from data/connectors/               │
│  - Validate connector structure                        │
│  - Check workflow ↔ connector compatibility (hash)     │
│  - Resolve entity keys → nodeId + field paths          │
│  - Apply values to workflow JSON nodes                 │
│  - Provide registry API for UI                         │
└──────────────────────┬────────────────────────────────┘
                       │ reads
┌──────────────────────▼────────────────────────────────┐
│                  Connector Files                        │
│  data/connectors/conn-*.json                           │
│                                                        │
│  Per-workflow configuration files that describe:       │
│  - Metadata (label, description, type, version)        │
│  - Input/output/parameter bindings                     │
│  - Compatibility constraints (node classes, hashes)    │
│  - Guide nodes for specialized workflows (LTX)         │
└──────────────────────┬────────────────────────────────┘
                       │ maps to
┌──────────────────────▼────────────────────────────────┐
│                   Workflow Layer                        │
│  data/workflows/*.json                                 │
│                                                        │
│  Raw ComfyUI workflow JSON templates.                  │
│  Should never be referenced directly by backend code.  │
│  All access goes through Connector Layer.              │
└───────────────────────────────────────────────────────┘
```

### 3.2 Key Architectural Decisions

#### Decision 1: Backend code MUST NOT reference nodeId directly

**Rule:** All backend code must access workflow nodes exclusively through the connector API (`cl.setValue`, `cl.getNodeId`, `cl.getBinding`).

**Current status:** ❌ Partially violated — some code still has hardcoded fallbacks.

**Migration path:** Remove all `FALLBACK_NODE` constants and legacy `else` branches in workflow builders.

#### Decision 2: Entity Schema is the single source of truth

The `entity-schema.js` file defines all valid data types. Connector bindings reference entities by their canonical key (`entityType: "positivePrompt"`). This enables:
- **Validation:** Unknown entity types are caught at startup
- **UI:** Auto-generated parameter editors based on entity metadata
- **AI tools:** The Workflow Assistant can reason about entities

#### Decision 3: Connectors are versioned independently

Each connector has `connectorVersion` (semver). This allows:
- Forward/backward compatibility checks
- Migration scripts between connector versions
- Gradual updates across the system

#### Decision 4: Workflow templates are immutable at runtime

`getWorkflow(name)` always returns a deep clone. On-disk templates are never modified. All runtime values are applied to the clone before sending to GPU Hub.

---

## 4. Data Flow: Request to Execution

```
User Action (App)
    │
    ▼
Backend (Scene Orchestrator)
    │  dispatches generation for a scene
    ▼
Service Layer (Audio/Image/Video Service)
    │  calls workflow builder with scene data
    ▼
Workflow Builder (audio/image/video-workflows.js)
    │  1. wfLoader.getWorkflow(name) → deep clone template
    │  2. wfLoader.getConnector(name) → connector object
    │  3. cl.setValue(wf, connector, 'positivePrompt', prompt)
    │  4. cl.setValue(wf, connector, 'totalFrames', 433)
    ▼
Filled Workflow JSON
    │  contains ComfyUI nodes with all values set
    ▼
GPU Dispatcher → GPU Hub → Worker → ComfyUI
    │
    ▼
Result returned → Task Handler → Scene completed
```

---

## 5. Current Limitations

| Limitation | Impact | Resolution Path |
|-----------|--------|-----------------|
| No hot-reload of workflows | Requires backend restart to add/modify workflows | Add file watcher + re-initialize API |
| Workflow builders still contain legacy fallbacks | Hardcoded nodeIds in fallback branches violate abstraction | Remove all fallback paths once connectors are required |
| No workflow status API | Cannot query active workflows from UI | Add `GET /api/v1/workflows` endpoint |
| No workflow registration API | Adding a workflow requires file system access | Add `POST /api/v1/workflows` with validation |
| Video workflows have 4-image limit | Hardcoded in group splitter | Make configurable or dynamic |
| All workflows are ComfyUI-specific | Cannot switch GPU platform | Abstract workflow execution behind an interface |

---

## 6. Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Workflow file corruption | Low | High | Validate JSON on load, hash verification |
| Connector-workflow mismatch | Medium | Medium | Hash check at startup, compatibility warnings |
| Backward compatibility after refactoring | Medium | High | Keep legacy fallbacks until full migration verified |
| Performance impact of deep cloning | Low | Low | Templates are small (< 100KB), clones are cheap |
| Hot-reload race conditions | Medium | Medium | Use lock file or atomic swap for reload |

---

## 7. Future Evolution

### Phase 1 — Current (v1.0.0)
- File-based workflow loading
- Connector-aware builders
- Startup validation

### Phase 2 — Workflow Manager (planned)
- Backend API for workflow CRUD
- Status/compatibility endpoints
- Frontend management screens

### Phase 3 — Developer Mode (planned)
- Node binding visualization
- Raw connector editor
- Mapping editor UI

### Phase 4 — Workflow Assistant (future)
- AI-powered connector generation
- Workflow analysis and diagnostics
- Automatic entity mapping
