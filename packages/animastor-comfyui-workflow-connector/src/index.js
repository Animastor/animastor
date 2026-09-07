// ======================================================
// Connector API — public surface of the
// animastor-comfyui-workflow-connector package
// ======================================================
// A small dependency-injected adapter over the mapping core
// (workflow-loader + connector-loader + entity-schema). It presents the
// API the package exposes to its host:
//
//   createWorkflowConnector({ workflowsDir, connectorsDir, logger })
//     .listWorkflows()   → [{ name, hash, type, label, hasConnector, compatible }]
//     .getWorkflow(name) → deep-cloned workflow JSON
//     .getConnector(name) → entity-level connector VIEW (no nodeIds/fields)
//     .validate(name)    → { compatible, warnings }
//     .build({ workflow, inputs, parameters }) → { workflowJson, workflowHash }
//
// Extraction invariants:
//   - ComfyUI node ids, field paths and the raw connector JSON format are
//     NOT part of this API. Binding application happens inside build().
//   - No dispatch, no queues, no GPU Hub, no DB/Redis, no business logic:
//     this package may only depend on node builtins
//     (guarded by tests/connector-core.test.js + the host architecture
//     suite tests/architecture/comfyui-connector-core-boundary.test.js).
//   - The host owns WHERE assets live (injected dirs) and HOW jobs are
//     dispatched (gpu-dispatcher stays host-side).

const wfLoader = require('./workflow-loader');
const connectorLoader = require('./connector-loader');

// ─── Typed errors ───────────────────────────────────

class ConnectorApiError extends Error {
    constructor(message, code) {
        super(message);
        this.name = this.constructor.name;
        this.code = code;
    }
}

/** Requested workflow is not loaded. */
class WorkflowNotFoundError extends ConnectorApiError {
    constructor(name) { super(`Workflow not found: ${name}`, 'WORKFLOW_NOT_FOUND'); }
}

/** Workflow has no connector registered (connectors are mandatory). */
class ConnectorMissingError extends ConnectorApiError {
    constructor(name) {
        super(`No connector registered for workflow "${name}". Connectors are mandatory for build().`,
            'CONNECTOR_MISSING');
    }
}

/** Workflow ↔ connector compatibility check failed (hash / node structure drift). */
class IncompatibleWorkflowError extends ConnectorApiError {
    constructor(name, warnings) {
        super(`Workflow "${name}" is incompatible with its connector:\n  - ${(warnings || []).join('\n  - ')}`,
            'INCOMPATIBLE_WORKFLOW');
        this.warnings = warnings || [];
    }
}

/** build() received inputs/parameters that the connector does not map. */
class BuildError extends ConnectorApiError {
    constructor(message) { super(message, 'BUILD_FAILED'); }
}

// ─── Connector view (entity-level, node-id-free) ────

/**
 * Strip ComfyUI-specific internals (nodeId, field, expectedClass) from a
 * binding section, keeping only the entity-level metadata.
 */
function sanitizeBindings(section) {
    if (!section || typeof section !== 'object') return {};
    const view = {};
    for (const [key, binding] of Object.entries(section)) {
        if (!binding || typeof binding !== 'object') continue;
        if (binding.type === 'multi' && Array.isArray(binding.bindings)) {
            view[key] = {
                type: 'multi',
                entityType: binding.entityType || key,
                label: binding.label || key,
                required: !!binding.required,
                count: binding.bindings.length,
            };
            continue;
        }
        view[key] = {
            entityType: binding.entityType || key,
            label: binding.label || key,
            required: !!binding.required,
        };
        if (binding.default !== undefined) view[key].default = binding.default;
        if (binding.min !== undefined) view[key].min = binding.min;
        if (binding.max !== undefined) view[key].max = binding.max;
    }
    return view;
}

/**
 * Entity-level connector view: everything a business consumer may know
 * about a workflow's ports WITHOUT seeing ComfyUI node ids or field paths.
 */
function toConnectorView(connector) {
    if (!connector) return null;
    return {
        name: connector.workflow,
        type: connector.type || 'unknown',
        label: connector.label || connector.workflow,
        description: connector.description || '',
        version: connector.connectorVersion || '1.0.0',
        profile: connector.profile || {},
        inputs: sanitizeBindings(connector.inputs),
        outputs: sanitizeBindings(connector.outputs),
        parameters: sanitizeBindings(connector.parameters),
    };
}

// ─── Public API factory ─────────────────────────────

/**
 * Create the workflow-connector API instance.
 *
 * @param {{ workflowsDir?: string, connectorsDir?: string, logger?: object }} [options]
 *   workflowsDir/connectorsDir — injected asset directories (host-owned);
 *   logger — injected logger (defaults to console).
 * @returns the API object (listWorkflows/getWorkflow/getConnector/validate/build/…)
 */
function createWorkflowConnector({ workflowsDir, connectorsDir, logger } = {}) {
    wfLoader.configure({ workflowsDir, logger });
    connectorLoader.configure({ connectorsDir, logger });

    // Load templates + connectors (connectors are mandatory: throws when a
    // workflow lacks one — the same fail-closed semantics the host startup
    // enforces via backend.cjs).
    function load() {
        return wfLoader.loadWorkflows();
    }
    load();

    return {
        load,

        /** All loaded workflows with entity-level metadata (no node ids). */
        listWorkflows() {
            const wfMap = wfLoader.workflows || {};
            return Object.keys(wfMap).map((name) => {
                const connector = connectorLoader.getConnector(name);
                let compatible = null;
                if (connector) {
                    compatible = connectorLoader.checkCompatibility(connector, wfMap[name]).compatible;
                }
                return {
                    name,
                    hash: wfLoader.getWorkflowHash(name),
                    hasConnector: !!connector,
                    type: connector ? connector.type || 'unknown' : null,
                    label: connector ? connector.label || name : name,
                    compatible,
                };
            });
        },

        /** Deep-cloned workflow JSON by name. Throws WorkflowNotFoundError. */
        getWorkflow(name) {
            try {
                return wfLoader.getWorkflow(name);
            } catch (err) {
                throw new WorkflowNotFoundError(name);
            }
        },

        /**
         * Entity-level connector VIEW for a workflow (no nodeIds/fields).
         * Throws ConnectorMissingError when the workflow has no connector.
         */
        getConnector(name) {
            const connector = connectorLoader.getConnector(name);
            if (!connector) throw new ConnectorMissingError(name);
            return toConnectorView(connector);
        },

        /**
         * Workflow ↔ connector compatibility check.
         * Throws WorkflowNotFoundError; returns { compatible, warnings }.
         */
        validate(name) {
            const wfMap = wfLoader.workflows || {};
            const wf = wfMap[name];
            if (!wf) throw new WorkflowNotFoundError(name);
            const connector = connectorLoader.getConnector(name);
            if (!connector) throw new ConnectorMissingError(name);
            return connectorLoader.checkCompatibility(connector, wf);
        },

        /**
         * Build a runnable workflow JSON from entity-keyed inputs and
         * parameters. Node ids and field paths stay inside the connector.
         *
         * @param {{ workflow: string, inputs?: object, parameters?: object }} request
         *   inputs     — { entityKey: value } applied via connector bindings
         *   parameters — { entityKey: value }; connector defaults fill gaps
         * @returns {{ workflowJson: object, workflowHash: string }}
         */
        build({ workflow, inputs = {}, parameters = {} } = {}) {
            if (!workflow || typeof workflow !== 'string') {
                throw new BuildError('build() requires a workflow name');
            }

            let wfJson;
            try {
                wfJson = wfLoader.getWorkflow(workflow);
            } catch (err) {
                throw new WorkflowNotFoundError(workflow);
            }

            const connector = connectorLoader.getConnector(workflow);
            if (!connector) throw new ConnectorMissingError(workflow);

            const compat = connectorLoader.checkCompatibility(connector, wfJson);
            if (!compat.compatible) throw new IncompatibleWorkflowError(workflow, compat.warnings);

            const unknownInputs = Object.keys(inputs).filter((k) => !connectorLoader.getBinding(connector, k));
            if (unknownInputs.length > 0) {
                throw new BuildError(`Unknown input key(s) for workflow "${workflow}": ${unknownInputs.join(', ')}`);
            }
            const unknownParams = Object.keys(parameters).filter((k) => !connector.parameters?.[k]);
            if (unknownParams.length > 0) {
                throw new BuildError(`Unknown parameter key(s) for workflow "${workflow}": ${unknownParams.join(', ')}`);
            }

            for (const [key, value] of Object.entries(inputs)) {
                connectorLoader.setValue(wfJson, connector, key, value);
            }
            for (const [key, param] of Object.entries(connector.parameters || {})) {
                const value = parameters[key] !== undefined ? parameters[key] : param.default;
                if (value === undefined) continue;
                connectorLoader.setValue(wfJson, connector, key, value);
            }

            return { workflowJson: wfJson, workflowHash: wfLoader.getWorkflowHash(workflow) };
        },

        /** Computed sha256 of a loaded workflow template. */
        getWorkflowHash(name) {
            return wfLoader.getWorkflowHash(name);
        },
    };
}

module.exports = {
    createWorkflowConnector,
    ConnectorApiError,
    WorkflowNotFoundError,
    ConnectorMissingError,
    IncompatibleWorkflowError,
    BuildError,

    // Compatibility surface (extraction §6.1): the loader singletons remain
    // reachable so host consumers migrated from backend/src/workflows/*
    // keep their exact call shapes. The createWorkflowConnector() factory
    // is the preferred long-term API.
    workflowLoader: wfLoader,
    connectorLoader,
    entitySchema: require('./entity-schema'),
};
