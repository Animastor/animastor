# animastor-comfyui-workflow-connector

Declarative mapping between data entities (prompts, images, audio, parameters) and ComfyUI workflow JSON.

Loads ComfyUI workflow templates and connector definitions from directories you provide, validates their compatibility (content-sensitive SHA-256 + node-class checks), applies entity-keyed bindings, and produces runnable workflow JSON — without exposing ComfyUI node IDs through the API boundary.

## Installation

```bash
npm install animastor-comfyui-workflow-connector
```

Requires Node.js >= 18. Zero runtime dependencies — uses only Node builtins (`fs`, `path`, `crypto`).

## Quick Start

```js
const { createWorkflowConnector } = require('animastor-comfyui-workflow-connector');

// Point the package at your workflow and connector directories
const connector = createWorkflowConnector({
    workflowsDir: '/path/to/workflows',
    connectorsDir: '/path/to/connectors',
    logger: console, // optional, defaults to console
});

// List loaded workflows
const workflows = connector.listWorkflows();
// → [{ name, hash, hasConnector, type, label, compatible }]

// Build a runnable workflow from entity-keyed inputs
const { workflowJson, workflowHash } = connector.build({
    workflow: 'my-workflow',
    inputs: { positivePrompt: 'A castle at dawn' },
    parameters: { steps: 30 },
});
// Send workflowJson to ComfyUI
```

## API

### `createWorkflowConnector(options)`

Factory function. Returns the connector API instance.

**Options:**

| Property | Type | Description |
|---|---|---|
| `workflowsDir` | `string` | Path to directory containing ComfyUI workflow JSON files |
| `connectorsDir` | `string` | Path to directory containing `conn-*.json` connector files |
| `logger` | `object` | Logger with `log()`, `warn()`, `error()` methods (defaults to `console`) |

Directories can also be set via `WF_DIR` and `CONNECTOR_DIR` environment variables, but explicit options take precedence.

### `.listWorkflows()`

Returns an array of loaded workflows with entity-level metadata:

```js
[{
    name: 'my-workflow',        // filename without .json
    hash: 'abc123...',          // SHA-256 of the workflow JSON
    hasConnector: true,         // whether a matching connector exists
    type: 'image',              // connector type: 'image' | 'audio' | 'video'
    label: 'My Workflow',       // human-readable label from connector
    compatible: true            // hash + node-class compatibility check result
}]
```

No ComfyUI node IDs are exposed.

### `.getWorkflow(name)`

Returns a deep-cloned workflow JSON object. Mutating the returned object does not affect the internal registry.

Throws `WorkflowNotFoundError` if the workflow name is not loaded.

### `.getConnector(name)`

Returns an entity-level view of the connector:

```js
{
    name: 'my-workflow',
    type: 'image',
    label: 'My Workflow',
    description: '',
    version: '1.0.0',
    profile: {},
    inputs: { positivePrompt: { entityType: 'string', label: 'Positive Prompt', required: true } },
    outputs: { generatedImage: { entityType: 'image', label: 'Generated Image', required: true } },
    parameters: { steps: { entityType: 'int', label: 'Steps', required: false, default: 20, min: 1, max: 100 } }
}
```

ComfyUI-specific internals (`nodeId`, `field`, `expectedClass`) are stripped from the output.

Throws `ConnectorMissingError` if no connector is registered for the workflow.

### `.validate(name)`

Returns `{ compatible: boolean, warnings: string[] }` after checking hash and node-class compatibility between a workflow and its connector.

Throws `WorkflowNotFoundError` or `ConnectorMissingError`.

### `.build({ workflow, inputs, parameters })`

Builds a runnable workflow JSON from entity-keyed inputs and parameters.

| Property | Type | Description |
|---|---|---|
| `workflow` | `string` | Workflow name (required) |
| `inputs` | `object` | `{ entityKey: value }` applied via connector bindings |
| `parameters` | `object` | `{ entityKey: value }`; connector defaults fill gaps for unspecified keys |

Returns `{ workflowJson, workflowHash }`.

Throws:
- `WorkflowNotFoundError` — workflow not loaded
- `ConnectorMissingError` — no connector registered
- `IncompatibleWorkflowError` — hash/node-class mismatch
- `BuildError` — unknown input/parameter keys or missing workflow name

### `.getWorkflowHash(name)`

Returns the SHA-256 hash string for a loaded workflow, or `null` if not found.

### `.load()`

Reloads all workflows and connectors from the configured directories.

## Typed Errors

All errors extend `ConnectorApiError` which extends `Error`. Each has a `code` property:

| Error | Code | When |
|---|---|---|
| `WorkflowNotFoundError` | `WORKFLOW_NOT_FOUND` | Requested workflow name not loaded |
| `ConnectorMissingError` | `CONNECTOR_MISSING` | No connector file for the workflow |
| `IncompatibleWorkflowError` | `INCOMPATIBLE_WORKFLOW` | Hash or node-class mismatch |
| `BuildError` | `BUILD_FAILED` | Invalid build input (missing name, unknown keys) |

```js
const { WorkflowNotFoundError } = require('animastor-comfyui-workflow-connector');

try {
    connector.getWorkflow('nonexistent');
} catch (err) {
    if (err instanceof WorkflowNotFoundError) {
        console.log(err.code); // 'WORKFLOW_NOT_FOUND'
        console.log(err.message); // 'Workflow not found: nonexistent'
    }
}
```

## Workflow Format

The package expects ComfyUI workflow JSON in the standard format — an object keyed by node IDs:

```json
{
    "1": {
        "class_type": "CLIPTextEncode",
        "inputs": { "text": "" }
    },
    "2": {
        "class_type": "KSampler",
        "inputs": { "seed": 42, "steps": 20 }
    }
}
```

Workflow files are plain `.json` files placed in the `workflowsDir` directory. Files prefixed with `old_` are ignored.

## Connector Format

Connector files define the mapping between data entities and workflow nodes. They live in `connectorsDir` and must be named `conn-*.json`:

```json
{
    "connectorVersion": "1.0.0",
    "workflow": "my-workflow",
    "type": "image",
    "label": "My Image Workflow",
    "description": "Generates images from text prompts",
    "inputs": {
        "positivePrompt": {
            "nodeId": "1",
            "field": "inputs.text",
            "entityType": "positivePrompt",
            "label": "Positive Prompt",
            "required": true
        }
    },
    "parameters": {
        "steps": {
            "nodeId": "2",
            "field": "inputs.steps",
            "entityType": "steps",
            "default": 20,
            "min": 1,
            "max": 100
        },
        "seed": {
            "nodeId": "2",
            "field": "inputs.seed",
            "entityType": "seed",
            "default": 42
        }
    }
}
```

**Key fields per binding:**

| Field | Description |
|---|---|
| `nodeId` | ComfyUI node ID in the workflow (internal, not exposed through API) |
| `field` | Dot-separated path within the node (e.g. `inputs.text`) |
| `entityType` | Canonical entity key (see Entity Types below) |
| `default` | Default value applied when parameter is not provided |
| `min` / `max` | Numeric bounds (for parameter validation) |
| `required` | Whether the binding must be provided |

### Multi-bindings

For workflows that accept arrays of inputs (e.g. multiple source images), use the `multi` type:

```json
{
    "sourceImages": {
        "type": "multi",
        "entityType": "sourceImages",
        "bindings": [
            { "nodeId": "10", "field": "inputs.image_1" },
            { "nodeId": "11", "field": "inputs.image_2" }
        ]
    }
}
```

## Entity Types

Built-in entity keys recognized by the validation system:

**Inputs:**
`positivePrompt`, `negativePrompt`, `narrationText`, `voiceInstruction`, `dialogueScript`, `defaultInstruct`, `character1Voice`, `character2Voice`, `character3Voice`, `roleName1`, `roleName2`, `roleName3`, `sourceImage`, `sourceImages`, `mask`, `characterImage`, `coverImage`, `audio`

**Outputs:**
`generatedImage`, `generatedVideo`, `generatedAudio`, `videoFrames`

**Parameters:**
`totalFrames`, `frameRate`, `width`, `height`, `steps`, `cfg`, `sampler`, `scheduler`, `seed`, `outputFilenamePrefix`, `fps`, `quality`, `language`, `temperature`, `guideFrameIndex`, `guideStrength`

Entity types with `image` or `image[]` type are not validated at runtime (they represent file paths or buffers). String/int/float types receive type checking in parameter updates.

## Compatibility Exports

For advanced use cases (e.g. migrating from internal APIs), the package also exports the underlying loader singletons:

```js
const { workflowLoader, connectorLoader, entitySchema } = require('animastor-comfyui-workflow-connector');
```

These expose the full internal API (node ID lookups, registry manipulation, etc.) and are intended for transitional compatibility only. Prefer `createWorkflowConnector()` for new code.

## Standalone Contract

This package has **zero** external dependencies:

```
your code ──requires──▶ animastor-comfyui-workflow-connector ──▶ fs/path/crypto
```

- No database, Redis, or HTTP dependencies
- No GPU Hub, dispatcher, or job protocol dependencies
- No hardcoded filesystem paths — all directories are injected at runtime
- No generated artifacts or secrets in the published package

The package ships only: `src/` (4 JS files), `README.md`, `LICENSE`, `package.json`.

## Running Tests

Tests are included in the repository but **not** in the published npm package:

```bash
git clone https://github.com/Animastor/animastor.git
cd animastor/packages/animastor-comfyui-workflow-connector
npm install
npm test
```

The test suite (34 tests) verifies workflow loading, connector validation, hash determinism, compatibility checks, binding application, the public API surface, typed errors, and dependency purity — all using local fixture files with zero host dependencies.

## License

MIT
