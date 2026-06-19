# Connector Architecture — Animastor

> **Version:** 1.0.0  
> **Status:** Draft  
> **Last updated:** 2026-06-19

---

## 1. Overview

The Connector System is a **declarative abstraction layer** that eliminates hardcoded references to ComfyUI workflow internals (node IDs, field paths) from backend code. Instead, all bindings are externalized into **connector configuration files**.

This document covers the current implementation, the target architecture, and the API surface for both backend and future UI consumption.

---

## 2. Core Concepts

### 2.1 What is a Connector?

A **Connector** is a JSON file that describes how a specific ComfyUI workflow maps to Animastor's data entities. It is the contract between the backend and the GPU generation pipeline.

Each connector defines:
- **Metadata** — label, description, type (audio/image/video), version
- **Compatibility** — expected node classes, workflow hash fingerprint
- **Input bindings** — which entity keys map to which workflow node inputs
- **Output bindings** — which workflow nodes produce which entity types
- **Parameter bindings** — configurable parameters with defaults and constraints
- **Guide nodes** — specialized bindings for LTX video guide frames

### 2.2 Entity Schema

Defined in `backend/src/workflows/entity-schema.js`, this is the canonical dictionary of all data types:

| Entity Key | Type | Kind | Label |
|-----------|------|------|-------|
| `positivePrompt` | string | input | Positive Prompt |
| `negativePrompt` | string | input | Negative Prompt |
| `narrationText` | string | input | Narration Text |
| `voiceInstruction` | string | input | Voice Instruction |
| `sourceImage` | image | input | Source Image |
| `sourceImages` | image[] | input | Source Images |
| `generatedImage` | image | output | Generated Image |
| `generatedVideo` | video | output | Generated Video |
| `generatedAudio` | audio | output | Generated Audio |
| `width` | int | parameter | Width |
| `height` | int | parameter | Height |
| `steps` | int | parameter | Steps |
| `cfg` | float | parameter | CFG Scale |
| `sampler` | string | parameter | Sampler |
| `scheduler` | string | parameter | Scheduler |
| `seed` | int | parameter | Seed |
| `totalFrames` | int | parameter | Total Frames |
| `fps` | int | parameter | FPS |

*(Full list in `entity-schema.js`)*

---

## 3. Current Implementation

### 3.1 Connector Loader (`backend/src/workflows/connector-loader.js`)

**Version:** v1.0.0

**Responsibilities:**
1. Load connectors from `data/connectors/` directory
2. Validate connector structure and field completeness
3. Validate workflow ↔ connector compatibility via hash
4. Provide lookup API for backend code
5. Apply values to workflow JSON nodes

### 3.2 API Surface (Current)

#### Lookup Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `getConnector(workflowName)` | `object\|null` | Get connector by workflow name (e.g., `"img-qwen-image"`) |
| `getConnectorByName(name)` | `object\|null` | Get connector by file name (e.g., `"conn-image-generation"`) |
| `getAllConnectors()` | `object[]` | Get all registered connectors |
| `getBinding(connector, entityKey)` | `object\|null` | Get binding descriptor for an entity key |
| `getNodeId(connector, entityKey)` | `string\|string[]\|null` | Get node ID (or array for multi-bindings) |
| `getGuideBindings(connector)` | `Array` | Get LTXVAddGuide bindings |

#### Value Application Methods

| Method | Description |
|--------|-------------|
| `setValue(workflow, connector, entityKey, value)` | Apply a value to workflow JSON via connector binding |
| `applyBinding(workflow, binding, value)` | Apply value via raw binding descriptor |

#### Validation Methods

| Method | Description |
|--------|-------------|
| `validateConnector(connector, name)` | Validate connector structure → `string[]` errors |
| `checkCompatibility(connector, workflowJson)` | Check connector vs workflow → `{ compatible, warnings }` |
| `computeWorkflowHash(workflowJson)` | Compute SHA-256 of normalized workflow JSON |
| `updateWorkflowHash(connector, workflowJson)` | Auto-populate hash on connector |

### 3.3 Validation Rules

**Structure validation** (applied at load time):
- `connectorVersion` — required
- `workflow` reference — required
- `type` — required (image/audio/video)
- `inputs` — each binding must have `nodeId` and `field`
- `outputs` — each binding must have `nodeId` and `field`
- `parameters` — each binding must have `nodeId` and `field`
- `guideNodes.bindings` — must be array, each entry must have `nodeId`
- `entityType` references — must exist in `entity-schema.js`

**Compatibility validation** (applied at startup):
- **Hash check:** SHA-256 of workflow JSON vs `workflowHash` in connector
- **Node class check:** Each node in `compatibility.nodeClasses` must exist in workflow with matching `class_type`
- **Binding existence check:** All referenced nodeIds must exist in the workflow
- **Guide node check:** All guide node references must exist

### 3.4 Connector File Format

```json
{
  "connectorVersion": "1.0.0",
  "workflow": "img-qwen-image",
  "workflowHash": "sha256-...",
  "label": "Image Generation (Qwen)",
  "description": "Generates images using Qwen-based ComfyUI workflow",
  "type": "image",
  "metadata": {
    "author": "Animastor",
    "updated": "2026-06-19",
    "category": "image-generation"
  },
  "compatibility": {
    "nodeClasses": {
      "108": "CLIPTextEncode",
      "1008": "SaveImage"
    }
  },
  "inputs": {
    "positivePrompt": {
      "nodeId": "108",
      "field": "inputs.text",
      "expectedClass": "CLIPTextEncode",
      "entityType": "positivePrompt",
      "label": "Positive Prompt",
      "required": true
    }
  },
  "outputs": {
    "generatedImage": {
      "nodeId": "1008",
      "field": "inputs.images",
      "expectedClass": "SaveImage",
      "entityType": "generatedImage",
      "label": "Generated Image"
    }
  },
  "parameters": {
    "width": {
      "nodeId": "110",
      "field": "inputs.width",
      "expectedClass": "EmptySD3LatentImage",
      "entityType": "width",
      "label": "Width",
      "default": 768,
      "min": 256,
      "max": 2048
    }
  },
  "guideNodes": {}
}
```

### 3.5 Registered Connectors

| Connector File | Workflow | Type | Inputs | Outputs | Parameters |
|---------------|----------|------|--------|---------|------------|
| `conn-image-generation.json` | `img-qwen-image` | image | 2 | 1 | 8 |
| `conn-tts-narration.json` | `tts-qwen-narrator` | audio | 2 | 1 | 5 |
| `conn-tts-dialogue.json` | `tts-qwen-dialogue` | audio | 6 | 1 | 3 |
| `conn-video-1p.json` | `video-ltx-1p` | video | 3 | 1 | 4 |
| `conn-video-2p.json` | `video-ltx-2p` | video | 3 | 1 | 4 |
| `conn-video-3p.json` | `video-ltx-3p` | video | 3 | 1 | 4 |
| `conn-video-4p.json` | `video-ltx-4p` | video | 3 | 1 | 4 |

---

## 4. Target Architecture

### 4.1 Enhanced Connector Layer

```
┌─────────────────────────────────────────────────────────┐
│              Connector Registry (NEW)                    │
│                                                         │
│  In-memory registry with:                               │
│  - Workflow → Connector index                           │
│  - Type index (audio/image/video)                       │
│  - Status tracking (compatible/warning/error)           │
│  - Last-validated timestamp                             │
│  - Hot-reload support                                   │
└──────────────────────┬──────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────┐
│              Connector Validator (v2.0)                  │
│                                                         │
│  Enhanced validation:                                   │
│  - Deep structure validation with error context         │
│  - Parameter type checking (int/float/string range)     │
│  - Cross-connector consistency checks                   │
│  - Version compatibility checks                         │
│  - Migration path detection                             │
└──────────────────────┬──────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────┐
│           Connector API (extended)                      │
│                                                         │
│  New endpoints for Workflow Manager:                    │
│  - GET /api/v1/connectors — list all                    │
│  - GET /api/v1/connectors/:name — details               │
│  - GET /api/v1/connectors/:name/compatibility — status  │
│  - POST /api/v1/connectors — register new               │
│  - PUT /api/v1/connectors/:name — update                │
│  - DELETE /api/v1/connectors/:name — remove             │
│  - POST /api/v1/connectors/:name/validate — validate    │
└─────────────────────────────────────────────────────────┘
```

### 4.2 New API Endpoints

#### `GET /api/v1/connectors`
Returns list of all registered connectors with status summary:

```json
{
  "connectors": [
    {
      "name": "conn-image-generation",
      "label": "Image Generation (Qwen)",
      "type": "image",
      "workflow": "img-qwen-image",
      "status": "compatible",
      "version": "1.0.0",
      "lastValidated": "2026-06-19T10:00:00Z"
    }
  ]
}
```

#### `GET /api/v1/connectors/:name/compatibility`
Returns detailed compatibility information:

```json
{
  "name": "conn-image-generation",
  "workflow": "img-qwen-image",
  "compatible": true,
  "hashMatch": true,
  "nodesChecked": 6,
  "nodesTotal": 6,
  "warnings": [],
  "errors": [],
  "workflowHash": "abc123...",
  "lastValidated": "2026-06-19T10:00:00Z"
}
```

#### `POST /api/v1/connectors/validate`
Validate a connector JSON without registering it.

#### `POST /api/v1/connectors/reload`
Trigger hot-reload of all connectors from disk.

### 4.3 Compatibility Status Model

```
Compatible ──► All checks pass
     │
     ├── Warning ──► Hash mismatch or missing optional nodes
     │
     └── Error ──► Missing required nodes, structural errors
```

Each status includes:
- Timestamp of last validation
- List of warnings and errors
- Hash comparison (expected vs actual)
- Node check results (passed/total)

### 4.4 Parameter Metadata

Parameters in connectors should be extended with:

```json
{
  "steps": {
    "nodeId": "120",
    "field": "inputs.steps",
    "expectedClass": "KSampler",
    "entityType": "steps",
    "label": "Steps",
    "description": "Number of diffusion sampling steps",
    "default": 8,
    "min": 1,
    "max": 100,
    "step": 1,
    "unit": "",
    "options": [],          // for enum-type parameters
    "advanced": false,      // show/hide in basic mode
    "group": "sampling"     // grouping for UI organization
  }
}
```

---

## 5. Migration Plan

### Phase 1: API Extension (back-end only)
- [ ] Add connector registry API endpoints
- [ ] Add connector validation endpoint
- [ ] Add hot-reload support
- [ ] Enhance parameter metadata in connector files

### Phase 2: UI Integration
- [ ] Connect Workflow Manager screens to API
- [ ] Build Compatibility display component
- [ ] Build Parameter editor component
- [ ] Build Developer Mode screens

### Phase 3: Legacy Cleanup
- [ ] Remove all hardcoded fallback node IDs from workflow builders
- [ ] Remove FALLBACK_NODE constants
- [ ] Make connectors required (fail startup if connector missing)

---

## 6. Risks and Considerations

| Risk | Mitigation |
|------|------------|
| Connector file syntax errors crash startup | Graceful degradation — warn and skip, don't crash |
| Hash mismatch after legitimate workflow update | Provide `POST /connectors/:name/rehash` endpoint |
| Large number of connectors impacts startup time | Lazy validation, only validate on first access |
| Backward compatibility with existing connectors | Maintain v1 connector format, add migration path to v2 |
| Security: connector JSON injection | Validate JSON against strict schema, reject unexpected fields |

---

## 7. Developer Mode API

In addition to the standard API, Developer Mode exposes:

**`GET /api/v1/connectors/:name/raw`** — Full raw connector JSON  
**`GET /api/v1/connectors/:name/bindings`** — Entity → node mapping table  
**`GET /api/v1/connectors/:name/mapping`** — Structured binding view

These endpoints are intended for internal tooling and developer UI only.
