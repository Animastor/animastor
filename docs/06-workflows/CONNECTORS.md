# Connector System — Animastor

## Overview

The Connector System is a **declarative abstraction layer** that eliminates hardcoded references to ComfyUI workflow internals (node IDs, field paths) from backend code.

Instead of backend code directly referencing node IDs like `"108"` or `"inputs.text"`, all such bindings are externalized into **connector configuration files**. This allows adding or modifying workflows without touching backend code.

## Architecture

The system is divided into three layers:

```
┌──────────────────────────────────────────────────┐
│                  Schema Layer                     │
│  entity-schema.js                                 │
│  Defines all Animastor data entities:            │
│  prompt, sourceImage, generatedVideo, etc.       │
└──────────────────┬───────────────────────────────┘
                   │ references
┌──────────────────▼───────────────────────────────┐
│                 Connector Layer                   │
│  connector-loader.js                              │
│  Loads, validates, and resolves bindings         │
│  Maps entity keys → workflow node paths          │
│  Checks compatibility via hash                   │
└──────────────────┬───────────────────────────────┘
                   │ reads
┌──────────────────▼───────────────────────────────┐
│              Connector Files                      │
│  data/connectors/                                 │
│  conn-image-generation.json                       │
│  conn-tts-narration.json                          │
│  conn-tts-dialogue.json                           │
│  conn-video-1p.json ... conn-video-4p.json       │
└──────────────────────────────────────────────────┘
                   │ maps to
┌──────────────────▼───────────────────────────────┐
│                Workflow Layer                     │
│  data/workflows/                                  │
│  img-qwen-image.json                              │
│  tts-qwen-narrator.json                           │
│  video-ltx-1p.json ... video-ltx-4p.json         │
└──────────────────────────────────────────────────┘
```

## File Locations

| Component | Path |
|-----------|------|
| Connector files | `data/connectors/conn-*.json` |
| Connector loader | `backend/src/workflows/connector-loader.js` |
| Entity schema | `backend/src/workflows/entity-schema.js` |
| Workflow files | `data/workflows/*.json` |
| Workflow loader | `backend/src/workflows/workflow-loader.js` |

## How It Works

### Startup Flow

1. `backend/src/backend.cjs` calls `wfLoader.loadWorkflows()`
2. `workflow-loader.js` loads all JSON workflow files from `data/workflows/`
3. `workflow-loader.js` then calls `connectorLoader.initialize(workflows)`
4. `connector-loader.js` loads all connector files from `data/connectors/`
5. Each connector is validated against its workflow (node class check, hash check)
6. Warnings are emitted for any incompatibilities

### Runtime Flow

When backend code needs to set a value on a workflow:

```javascript
// OLD (hardcoded):
wfImg["108"].inputs.text = prompt;
wfImg["109"].inputs.text = negativePrompt;

// NEW (connector-based):
const cl = require('../workflows/connector-loader');
const connector = wfLoader.getConnector('img-qwen-image');
cl.setValue(wfImg, connector, 'positivePrompt', prompt);
cl.setValue(wfImg, connector, 'negativePrompt', negativePrompt);
```

The connector handles the nodeId-to-field mapping. Backend only knows entity keys.

## Connector File Format

### Structure

```json
{
  "connectorVersion": "1.0.0",
  "workflow": "img-qwen-image",
  "workflowHash": "sha256-...",
  "label": "Human-readable label",
  "description": "Description of this workflow",
  "type": "image|audio|video",
  "metadata": {
    "author": "Animastor",
    "updated": "2026-06-19",
    "category": "image-generation",
    "maxImages": 1
  },
  "compatibility": {
    "nodeClasses": {
      "108": "CLIPTextEncode",
      "109": "CLIPTextEncode"
    }
  },
  "inputs": { ... },
  "outputs": { ... },
  "parameters": { ... },
  "guideNodes": { ... }
}
```

### Top-level Fields

| Field | Required | Description |
|-------|----------|-------------|
| `connectorVersion` | ✅ | Semver version of the connector format |
| `workflow` | ✅ | Name of the corresponding workflow file (without .json) |
| `workflowHash` | ✅ | SHA-256 hash of the workflow (for compatibility check) |
| `label` | ✅ | Human-readable name |
| `description` | ✅ | Description of what the workflow does |
| `type` | ✅ | One of: `image`, `audio`, `video` |
| `metadata` | ❌ | Additional metadata (author, updated, category, maxImages) |
| `compatibility` | ❌ | Node class expectations for validation |
| `inputs` | ✅ | Input entity bindings |
| `outputs` | ❌ | Output entity bindings |
| `parameters` | ❌ | Parameter bindings (for future UI editing) |
| `guideNodes` | ❌ | LTXVAddGuide node bindings (LTX video only) |

### Binding Structure

Each binding in `inputs`, `outputs`, or `parameters` has:

```json
{
  "nodeId": "108",
  "field": "inputs.text",
  "expectedClass": "CLIPTextEncode",
  "entityType": "positivePrompt",
  "label": "Positive Prompt",
  "required": true
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `nodeId` | ✅ | Node ID in the ComfyUI workflow |
| `field` | ✅ | Field path on the node (e.g., `inputs.text`) |
| `expectedClass` | ❌ | Expected class_type for validation |
| `entityType` | ❌ | Reference to entity-schema.js type |
| `label` | ❌ | Human-readable label for UI |
| `required` | ❌ | Whether this binding must have a value |

### Multi-bindings

For arrays of similar nodes (e.g., 4 LoadImage nodes for LTX video):

```json
{
  "sourceImages": {
    "type": "multi",
    "bindings": [
      { "nodeId": "149", "field": "inputs.image", "arrayPosition": 0 },
      { "nodeId": "179", "field": "inputs.image", "arrayPosition": 1 },
      { "nodeId": "187", "field": "inputs.image", "arrayPosition": 2 },
      { "nodeId": "216", "field": "inputs.image", "arrayPosition": 3 }
    ]
  }
}
```

### Guide Nodes (LTX Video)

Special structure for LTXVAddGuide nodes:

```json
{
  "guideNodes": {
    "nodeType": "LTXVAddGuide",
    "bindings": [
      {
        "nodeId": "199",
        "fieldFrameIdx": "inputs.frame_idx",
        "fieldStrength": "inputs.strength",
        "imageSource": "inputs.image"
      }
    ]
  }
}
```

## Entity Schema

The entity schema (`backend/src/workflows/entity-schema.js`) defines all possible data types that can flow between backend and ComfyUI:

| Entity Key | Type | Kind | Description |
|------------|------|------|-------------|
| `positivePrompt` | string | input | Main text prompt |
| `negativePrompt` | string | input | Undesired content prompt |
| `narrationText` | string | input | TTS narration text |
| `voiceInstruction` | string | input | Voice description |
| `dialogueScript` | string | input | Multi-role script |
| `sourceImage` | image | input | Single input image |
| `sourceImages` | image[] | input | Array of input images |
| `generatedImage` | image | output | Generated image |
| `generatedVideo` | video | output | Generated video |
| `generatedAudio` | audio | output | Generated audio |
| `totalFrames` | int | parameter | Video frame count |
| `width` | int | parameter | Output width |
| `height` | int | parameter | Output height |
| `steps` | int | parameter | Sampling steps |
| `cfg` | float | parameter | CFG scale |
| `language` | string | parameter | Language for TTS output (e.g. Russian, English) |
| `temperature` | float | parameter | Sampling temperature for generation randomness |
| ... | ... | ... | ... |

## Compatibility Validation

### Hash-based Validation

On startup, the connector loader:

1. Computes SHA-256 of the workflow JSON
2. Compares against the `workflowHash` stored in the connector
3. If mismatch: marks connector as potentially incompatible, emits warning

This protects against workflows being modified without updating the connector.

### Node Class Validation

If `compatibility.nodeClasses` is present:

1. Each node ID in the connector is checked against the workflow
2. If a node is missing: incompatibility warning
3. If class_type differs: incompatibility warning

### Example Warning

```
[CONNECTOR] ⚠️ Node 108 (expected CLIPTextEncode) not found in workflow "img-qwen-image".
             The workflow structure may have changed.
[CONNECTOR] ⚠️ Workflow hash mismatch for "video-ltx-1p":
             connector expects abc123, got def456.
```

## Adding a New Workflow

### Step 1: Create Workflow File

Place a ComfyUI workflow JSON in `data/workflows/`:

```bash
data/workflows/my-new-workflow.json
```

### Step 2: Create Connector File

Create a corresponding connector in `data/connectors/`:

```bash
data/connectors/conn-my-new-workflow.json
```

### Minimal Connector Example

```json
{
  "connectorVersion": "1.0.0",
  "workflow": "my-new-workflow",
  "workflowHash": "",
  "label": "My New Workflow",
  "description": "Description",
  "type": "image",
  "compatibility": {
    "nodeClasses": {
      "42": "CLIPTextEncode",
      "99": "KSampler"
    }
  },
  "inputs": {
    "positivePrompt": {
      "nodeId": "42",
      "field": "inputs.text",
      "expectedClass": "CLIPTextEncode",
      "entityType": "positivePrompt",
      "label": "Positive Prompt",
      "required": true
    }
  },
  "parameters": {
    "steps": {
      "nodeId": "99",
      "field": "inputs.steps",
      "expectedClass": "KSampler",
      "entityType": "steps",
      "label": "Steps",
      "default": 20
    }
  }
}
```

### Step 3: Update Backend Code

No update needed **if** the backend already uses connector-based entity keys through `image-service.js`, `audio-service.js`, or `video-workflows.js`.

For new workflow types, use the connector API:

```javascript
const wfLoader = require('../workflows/workflow-loader');
const connector = wfLoader.getConnector('my-new-workflow');
const workflow = wfLoader.getWorkflow('my-new-workflow');
// Apply values via connector
connectorLoader.setValue(workflow, connector, 'positivePrompt', prompt);
```

## Connector Loader API

### Lookup

| Method | Description |
|--------|-------------|
| `getConnector(workflowName)` | Get connector by workflow name |
| `getConnectorByName(name)` | Get connector by file name |
| `getAllConnectors()` | Get all registered connectors |
| `getBinding(connector, entityKey)` | Get binding descriptor for entity |
| `getNodeId(connector, entityKey)` | Get node ID(s) for entity |
| `getGuideBindings(connector)` | Get LTXVAddGuide bindings |

### Value Application

| Method | Description |
|--------|-------------|
| `setValue(workflow, connector, entityKey, value)` | Apply value via connector binding |
| `applyBinding(workflow, binding, value)` | Apply value via raw binding |

### Validation

| Method | Description |
|--------|-------------|
| `checkCompatibility(connector, workflowJson)` | Check connector vs workflow |
| `computeWorkflowHash(workflowJson)` | Compute SHA-256 of workflow |
| `updateWorkflowHash(connector, workflowJson)` | Update connector hash |

## Code Migration Status

| Component | Status | Hardcoded Node IDs Eliminated |
|-----------|--------|-------------------------------|
| `image-service.js` | ✅ | `"108"`, `"109"` → connector |
| `image-workflows.js` | ✅ | `"108"`, `"109"` → connector |
| `audio-service.js` | ✅ | `"108"`, `"71"`, `"80"`, `"74"` → connector |
| `audio-workflows.js` | ✅ | `"108"`, `"71"`, `"80"`, `"74"` → connector |
| `video-workflows.js` | ✅ | `NODE` map → connector resolution |

## Future Directions

### UI Workflow Configurator

The entity schema + connector format are designed for a future visual editor:

- **Left panel**: Available entities from entity-schema.js (Prompt, Source Image, etc.)
- **Right panel**: Workflow nodes from connector
- **Middle**: Binding table showing connections

### Workflow Parameter Editing

Connector `parameters` section already supports:

- `default` — default value
- `min`/`max` — validation ranges
- Future: editable from UI

### Multi-Instance Workflows

For workflows that support varying numbers of inputs (like LTX video 1p/2p/3p/4p), each variant gets its own connector. A future enhancement could unify them with conditional bindings.

## Maintenance Guidelines

1. **After modifying a workflow**, regenerate its hash:
   ```javascript
   const cl = require('./backend/src/workflows/connector-loader');
   const wf = require('./data/workflows/my-workflow.json');
   console.log(cl.computeWorkflowHash(wf));
   ```
   Update `workflowHash` in the connector file.

2. **When adding new nodes** to a workflow, update `compatibility.nodeClasses` in the connector.

3. **When removing nodes** from a workflow, remove or update their bindings in the connector.

4. **Connector file naming**: prefix with `conn-`, followed by a descriptive name, ending with `.json`.

5. **Keep connectors and workflows in sync**: a commit that changes a workflow should include the corresponding connector update.
