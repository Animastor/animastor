# animastor-comfyui-workflow-connector

Declarative mapping core between Animastor data entities (prompts, images,
audio, generation parameters) and ComfyUI workflow JSON.

**Extraction basis:** `docs/architecture/COMFYUI_WORKFLOW_CONNECTOR_EXTRACTION_READINESS.md`
(§1 frozen boundary, §2 public API, §6 migration order).

## What it does

- Loads ComfyUI workflow JSON (`{ "nodeId": { class_type, inputs } }` API format)
  and `conn-*.json` connector files from **host-injected directories**.
- Validates connector structure and workflow ↔ connector compatibility
  (content-sensitive sha256 hash + node-class + per-binding expectedClass checks).
- Applies entity-keyed inputs/parameters to workflow JSON via connector
  bindings (node ids never cross the API boundary).
- `build()` produces the runnable workflow JSON — the only output that
  contains node ids, and only in the payload the host itself dispatches.

## Public API

```js
const { createWorkflowConnector } = require('animastor-comfyui-workflow-connector');

const wf = createWorkflowConnector({
    workflowsDir: '/host/ai/workflows',     // host-owned, injected
    connectorsDir: '/host/ai/connectors',   // host-owned, injected
    logger,                                  // injected (defaults to console)
});

wf.listWorkflows()  // → [{ name, hash, hasConnector, type, label, compatible }]  (no node ids)
wf.getWorkflow(n)   // → deep-cloned workflow JSON; throws WorkflowNotFoundError
wf.getConnector(n)  // → entity-level VIEW { inputs, outputs, parameters, profile, … }
                    //   nodeId/field/expectedClass STRIPPED; throws ConnectorMissingError
wf.validate(n)      // → { compatible, warnings }
wf.build({ workflow, inputs, parameters })
                    // → { workflowJson, workflowHash }; connector defaults applied;
                    //   unknown entity keys → BuildError; incompatible → IncompatibleWorkflowError
```

Typed errors: `WorkflowNotFoundError`, `ConnectorMissingError`,
`IncompatibleWorkflowError`, `BuildError`, base `ConnectorApiError`.

**Compatibility surface:** the package also re-exports the underlying loader
singletons (`workflowLoader`, `connectorLoader`, `entitySchema`) so the
host consumers migrated from `backend/src/workflows/*` keep their exact
call shapes (§6.1 of the extraction readiness doc).

## Dependency direction (hard contract)

```
host business layer ──requires──▶ animastor-comfyui-workflow-connector ──▶ fs/path/crypto
```

The package depends on **nothing but Node builtins**: no DB, no Redis,
no HTTP, no GPU Hub, no dispatcher, no generation/business code.
Guarded by `tests/connector-core.test.js` (standalone purity) and the host
architecture suite (`backend/tests/architecture/comfyui-connector-core-boundary.test.js`).

## Asset directories (host-owned)

The package ships **no** workflow/connector assets. The host injects the
directories at boot (`configure()` DI / `createWorkflowConnector` options).
Fallback resolution order: explicit injection → `WF_DIR` / `CONNECTOR_DIR`
env vars. In the Animastor monorepo the host (backend) passes
`backend/ai/workflows` and `backend/ai/connectors`.

## Tests

```
npm install
npm test
```

The suite (34 tests) proves the core works standalone with local fixtures:
loading, entity schema, hash determinism/content-sensitivity, compatibility,
binding application (incl. multi-bindings), the public API surface, typed
errors, node-id hiding and fail-closed loading semantics.

## Installation in the Animastor monorepo

The package is resolved via the repo-root `node_modules` symlink
(same pattern as `@animastor/contracts`; see
`docs/architecture/PHASE_9C_CONTRACTS_EXTRACTION_AUDIT.md` §3.1 for the
docker build-context rationale):

```
mkdir -p node_modules
ln -sfn ../packages/animastor-comfyui-workflow-connector node_modules/animastor-comfyui-workflow-connector
```

Docker: the backend build context is `./backend`, so the package is mounted
read-only into the container by docker-compose:

```
./packages/animastor-comfyui-workflow-connector:/app/node_modules/animastor-comfyui-workflow-connector:ro
```
