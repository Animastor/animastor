// ======================================================
// Workflow Manager — v1.0.0
// ======================================================
// Orchestration layer that wraps connector-loader and
// workflow-loader for the API layer.
//
// Provides:
//   - Connector status summaries with real-time compatibility
//   - Workflow status summaries
//   - Validation of connector JSON
//   - Hot-reload orchestration
// ======================================================

const connectorLoader = require('../workflows/connector-loader');
const workflowLoader = require('../workflows/workflow-loader');
const entitySchema = require('../workflows/entity-schema');

const logPrefix = '[WF-MANAGER]';

function log(msg) { console.log(`${logPrefix} ${msg}`); }

// ─── Helper: find connector name by reverse lookup ─

/**
 * Given a connector object, find its registered name.
 * @param {object} connector
 * @returns {string|null}
 */
function findConnectorName(connector) {
    if (!connector) return null;
    return Object.keys(connectorLoader.connectorsByName)
        .find(k => connectorLoader.connectorsByName[k] === connector) || null;
}

// ─── Connector Management ──────────────────────────

/**
 * Get all connectors with status information.
 * Runs compatibility check on-the-fly using loaded workflows.
 */
function listConnectors() {
    const workflows = workflowLoader.workflows || {};
    return connectorLoader.getConnectorStatuses(workflows);
}

/**
 * Get detailed info for a single connector.
 * @param {string} connectorName — name like "conn-image-generation"
 */
function getConnectorDetail(connectorName) {
    const connector = connectorLoader.getConnectorByName(connectorName);
    if (!connector) return null;

    // Don't expose the raw workflow JSON in the detail — just metadata
    const { inputs, outputs, parameters, guideNodes, ...meta } = connector;

    // Transform bindings to a cleaner format for UI
    const cleanBindings = (bindings) => {
        const result = {};
        for (const [key, binding] of Object.entries(bindings || {})) {
            if (binding.type === 'multi' && binding.bindings) {
                result[key] = {
                    type: 'multi',
                    label: binding.label || key,
                    entityType: binding.entityType,
                    required: binding.required,
                    bindings: binding.bindings.map(b => ({
                        nodeId: b.nodeId,
                        label: b.label,
                        entityType: b.entityType,
                        required: b.required,
                        arrayPosition: b.arrayPosition
                    }))
                };
            } else {
                const entity = entitySchema.getEntity(binding.entityType || key);
                result[key] = {
                    nodeId: binding.nodeId,
                    field: binding.field,
                    label: binding.label || entity?.label || key,
                    entityType: binding.entityType,
                    required: binding.required,
                    dataType: entity?.type || null,
                    kind: entity?.kind || null,
                    defaultValue: binding.default !== undefined ? binding.default : null,
                    min: binding.min !== undefined ? binding.min : null,
                    max: binding.max !== undefined ? binding.max : null
                };
            }
        }
        return result;
    };

    return {
        name: connectorName,
        workflow: meta.workflow,
        workflowHash: meta.workflowHash,
        label: meta.label || connectorName,
        description: meta.description || '',
        type: meta.type || 'unknown',
        version: meta.connectorVersion || '1.0.0',
        metadata: meta.metadata || {},
        inputs: cleanBindings(inputs),
        outputs: cleanBindings(outputs),
        parameters: cleanBindings(parameters),
        hasGuideNodes: !!(guideNodes?.bindings?.length)
    };
}

/**
 * Get live compatibility status for a connector.
 * @param {string} connectorName
 * @returns {object|null} — null if connector not found
 */
function getConnectorCompatibility(connectorName) {
    const connector = connectorLoader.getConnectorByName(connectorName);
    if (!connector) return null;

    const workflows = workflowLoader.workflows || {};
    const wf = workflows[connector.workflow];

    if (!wf) {
        return {
            name: connectorName,
            workflow: connector.workflow,
            compatible: false,
            error: `Workflow "${connector.workflow}" not found in workflow map`
        };
    }

    const compat = connectorLoader.checkCompatibility(connector, wf);
    const wfHash = workflowLoader.getWorkflowHash(connector.workflow);

    // Count node checks
    const nodeClasses = connector.compatibility?.nodeClasses || {};
    const nodesChecked = Object.keys(nodeClasses).length;

    return {
        name: connectorName,
        workflow: connector.workflow,
        compatible: compat.compatible,
        hashMatch: !compat.warnings.some(w => w.includes('hash mismatch')),
        nodesChecked,
        nodesTotal: nodesChecked,
        warnings: compat.warnings,
        errors: [],
        workflowHash: wfHash || null,
        lastValidated: new Date().toISOString()
    };
}

/**
 * Validate a connector JSON object without registering it.
 * @param {object} connectorJson — raw connector JSON
 * @param {string} [suggestedName] — optional name for error messages
 * @returns {{ valid: boolean, errors: string[], structureErrors: string[], compatibility: object|null }}
 */
function validateConnectorJson(connectorJson, suggestedName) {
    const name = suggestedName || '(unnamed)';
    const errors = [];

    // 1. Structure validation
    const structureErrors = connectorLoader.validateConnector(connectorJson, name);

    // 2. Check referenced workflow exists
    const workflows = workflowLoader.workflows || {};
    const wfName = connectorJson.workflow;
    let compatibility = null;

    if (wfName && workflows[wfName]) {
        compatibility = connectorLoader.checkCompatibility(connectorJson, workflows[wfName]);

        if (!compatibility.compatible) {
            errors.push(...compatibility.warnings);
        }
    } else if (wfName) {
        errors.push(`Referenced workflow "${wfName}" not found in loaded workflows`);
    }

    return {
        valid: structureErrors.length === 0 && errors.length === 0,
        structureErrors,
        compatibility,
        errors
    };
}

/**
 * Reload all connectors from disk.
 * @returns {{ connectors: number, warnings: string[], errors: string[] }}
 */
function reloadConnectors() {
    log('Hot-reload triggered...');
    const workflows = workflowLoader.workflows || {};
    const result = connectorLoader.reload(workflows);

    log(`Reload complete: ${Object.keys(result.connectors).length} connectors, ` +
        `${result.warnings.length} warnings, ${result.errors.length} errors`);

    return {
        connectors: Object.keys(result.connectors).length,
        warnings: result.warnings,
        errors: result.errors
    };
}

// ─── Workflow Management ───────────────────────────

/**
 * List all loaded workflows with basic info.
 */
function listWorkflows() {
    const workflows = workflowLoader.workflows || {};
    const result = [];

    for (const [name, wf] of Object.entries(workflows)) {
        const connector = connectorLoader.getConnector(name);
        const hash = workflowLoader.getWorkflowHash(name);

        // Detect type from connector or from workflow node types
        let type = connector?.type || 'unknown';
        if (type === 'unknown') {
            // Heuristic: check for common node types
            const nodeTypes = new Set();
            for (const [, node] of Object.entries(wf)) {
                if (node.class_type) nodeTypes.add(node.class_type);
            }
            if (nodeTypes.has('Qwen3TTSVoiceDesign') || nodeTypes.has('Qwen3TTSLoader')) type = 'audio';
            else if (nodeTypes.has('SaveVideo') || nodeTypes.has('LTXVAddGuide')) type = 'video';
            else if (nodeTypes.has('SaveImage')) type = 'image';
        }

        result.push({
            name,
            type,
            nodes: Object.keys(wf).length,
            hasConnector: !!connector,
            connectorName: findConnectorName(connector),
            hash: hash ? hash.slice(0, 16) + '...' : null
        });
    }
    return result;
}

/**
 * Get workflow details.
 * @param {string} name — workflow name
 * @returns {object|null}
 */
function getWorkflowDetail(name) {
    const workflows = workflowLoader.workflows || {};
    const wf = workflows[name];
    if (!wf) return null;

    const hash = workflowLoader.getWorkflowHash(name);
    const connector = connectorLoader.getConnector(name);

    // Collect node types present
    const nodeTypes = {};
    for (const [nodeId, node] of Object.entries(wf)) {
        if (node.class_type) {
            nodeTypes[nodeId] = node.class_type;
        }
    }

    return {
        name,
        nodes: Object.keys(wf).length,
        nodeTypes,
        hash: hash || null,
        hasConnector: !!connector,
        connectorName: findConnectorName(connector)
    };
}

/**
 * Get SHA-256 hash for a workflow.
 * @param {string} name — workflow name
 * @returns {string|null}
 */
function getWorkflowHash(name) {
    return workflowLoader.getWorkflowHash(name);
}

// ─── Raw / Developer Mode ─────────────────────────

/**
 * Get the raw connector object (includes nodeIds, fields, bindings).
 * Used by Developer Mode UI.
 * @param {string} connectorName
 * @returns {object|null}
 */
function getRawConnector(connectorName) {
    return connectorLoader.getConnectorByName(connectorName);
}

/**
 * Get all connectors grouped by type with status information.
 * @returns {object} — { audio: [], image: [], video: [], unknown: [] }
 */
function getConnectorsGrouped() {
    const grouped = connectorLoader.getConnectorsByType();
    const workflows = workflowLoader.workflows || {};
    const result = {};

    for (const [type, conns] of Object.entries(grouped)) {
        result[type] = conns.map(c => {
            const wfName = c.workflow;
            let status = 'unknown';
            if (workflows[wfName]) {
                const compat = connectorLoader.checkCompatibility(c, workflows[wfName]);
                status = compat.compatible ? 'compatible' : 'incompatible';
            }
            return {
                name: findConnectorName(c) || c.workflow,
                label: c.label || c.workflow,
                workflow: c.workflow,
                type: c.type,
                status,
                version: c.connectorVersion || '1.0.0',
                description: c.description || ''
            };
        });
    }
    return result;
}

// ─── Parameter Management ────────────────────────────

/**
 * Update a connector parameter's value.
 * Validates type, min/max, and persists to in-memory registry.
 *
 * @param {string} connectorName
 * @param {string} paramKey
 * @param {*} value
 * @returns {{ ok: boolean, error?: string, previousValue?: *, currentValue?: *, warnings?: string[] }}
 */
function updateConnectorParameter(connectorName, paramKey, value) {
    const connector = connectorLoader.getConnectorByName(connectorName);
    if (!connector) {
        return { ok: false, error: `Connector "${connectorName}" not found` };
    }

    if (!connector.parameters || !connector.parameters[paramKey]) {
        return { ok: false, error: `Parameter "${paramKey}" not found on connector "${connectorName}"` };
    }

    const result = connectorLoader.updateConnectorParameter(connectorName, paramKey, value);
    if (result.ok) {
        log(`Parameter updated: ${connectorName}.${paramKey} = ${JSON.stringify(value)}`);
    }
    return result;
}

/**
 * Reset a connector parameter to its current stored value (in-memory default).
 * @param {string} connectorName
 * @param {string} paramKey
 * @returns {{ ok: boolean, error?: string, currentValue?: * }}
 */
function resetConnectorParameter(connectorName, paramKey) {
    const connector = connectorLoader.getConnectorByName(connectorName);
    if (!connector) {
        return { ok: false, error: `Connector "${connectorName}" not found` };
    }

    if (!connector.parameters || !connector.parameters[paramKey]) {
        return { ok: false, error: `Parameter "${paramKey}" not found on connector "${connectorName}"` };
    }

    return connectorLoader.resetConnectorParameter(connectorName, paramKey);
}

/**
 * Get all current parameter values for a connector.
 * @param {string} connectorName
 * @returns {{ [key: string]: * }|null}
 */
function getConnectorParameterValues(connectorName) {
    const connector = connectorLoader.getConnectorByName(connectorName);
    if (!connector || !connector.parameters) return null;

    const values = {};
    for (const [key, param] of Object.entries(connector.parameters)) {
        values[key] = param.default !== undefined ? param.default : null;
    }
    return values;
}

// ─── Entity Schema ─────────────────────────────────

/**
 * List all entities from the entity schema.
 */
function listEntities() {
    return entitySchema.ENTITIES;
}

/**
 * Get entities by kind (input/output/parameter).
 * @param {string} kind
 */
function getEntitiesByKind(kind) {
    return entitySchema.getEntitiesByKind(kind);
}

// ─── Connector Status (Enable/Disable) ──────────────

/**
 * Set a connector's enabled/disabled status.
 * @param {string} connectorName
 * @param {boolean} enabled
 * @returns {{ ok: boolean, error?: string, enabled?: boolean }}
 */
function setConnectorStatus(connectorName, enabled) {
    const connector = connectorLoader.getConnectorByName(connectorName);
    if (!connector) {
        return { ok: false, error: `Connector "${connectorName}" not found` };
    }
    const result = connectorLoader.setConnectorStatus(connectorName, enabled);
    log(`Connector "${connectorName}" status set to ${enabled ? 'enabled' : 'disabled'}`);
    return result;
}

/**
 * Check if a connector is currently enabled.
 * @param {string} connectorName
 * @returns {boolean}
 */
function isConnectorEnabled(connectorName) {
    return connectorLoader.isConnectorEnabled(connectorName);
}

/**
 * Get all connector statuses including enabled/disabled info.
 */
function listConnectorStatuses() {
    const connectors = connectorLoader.getAllConnectors();
    return connectors.map(c => {
        const name = findConnectorName(c);
        return {
            name,
            enabled: name ? connectorLoader.isConnectorEnabled(name) : true
        };
    });
}

// ─── Exports ────────────────────────────────────────

module.exports = {
    // Connector
    listConnectors,
    getConnectorDetail,
    getConnectorCompatibility,
    validateConnectorJson,
    reloadConnectors,
    getRawConnector,
    getConnectorsGrouped,

    // Parameter Management
    updateConnectorParameter,
    getConnectorParameterValues,

    // Connector Status (Enable/Disable)
    setConnectorStatus,
    isConnectorEnabled,
    listConnectorStatuses,

    // Workflow
    listWorkflows,
    getWorkflowDetail,
    getWorkflowHash,

    // Entity Schema
    listEntities,
    getEntitiesByKind
};
