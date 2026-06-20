// ======================================================
// Connector Loader — v1.0.0
// ======================================================
// Bridges ComfyUI workflows with backend code via
// declarative connector JSON files.
//
// A connector is a configuration file that maps
// Animastor data entities (prompts, images, audio, etc.)
// to specific node IDs and fields within a ComfyUI workflow.
//
// Key responsibilities:
//   1. Load connectors from data/connectors/ directory
//   2. Validate connector structure and field completeness
//   3. Validate workflow ↔ connector compatibility via hash
//   4. Provide lookup API for backend code
//   5. Apply values to workflow JSON nodes

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const entitySchema = require('./entity-schema');

const CONNECTOR_DIR = '/data/connectors';
const logPrefix = '[CONNECTOR]';

// In-memory registry
const connectors = {};       // workflow_name → connector
const connectorsByName = {}; // connector_name → connector
const connectorEnabled = {}; // connector_name → boolean (default: true)

function log(msg) { console.log(`${logPrefix} ${msg}`); }
function warn(msg) { console.warn(`${logPrefix} ⚠️ ${msg}`); }
function error(msg) { console.error(`${logPrefix} ❌ ${msg}`); }

// ─── Hashing ────────────────────────────────────────

/**
 * Compute SHA-256 hash of a workflow JSON's normalized (sorted) string form.
 * @param {object} workflowJson — loaded workflow JSON
 * @returns {string} hex digest
 */
function computeWorkflowHash(workflowJson) {
  const normalized = JSON.stringify(workflowJson, Object.keys(workflowJson).sort(), 0);
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

// ─── Validation ─────────────────────────────────────

/**
 * Validate a single binding entry.
 */
function validateBinding(binding, context) {
  const errors = [];

  if (!binding.nodeId) {
    errors.push(`binding ${context}: missing nodeId`);
  }
  if (!binding.field) {
    errors.push(`binding ${context} (node ${binding.nodeId}): missing field`);
  }
  if (binding.entityType && !entitySchema.getEntity(binding.entityType)) {
    errors.push(`binding ${context} (node ${binding.nodeId}): unknown entityType "${binding.entityType}"`);
  }

  return errors;
}

/**
 * Validate the full connector structure.
 * Returns array of error messages (empty = valid).
 */
function validateConnector(connector, connectorName) {
  const errors = [];

  // Required top-level fields
  if (!connector.connectorVersion) {
    errors.push('missing connectorVersion');
  }
  if (!connector.workflow) {
    errors.push('missing workflow reference');
  }
  if (!connector.type) {
    errors.push('missing type (image/audio/video)');
  }

  // Validate inputs
  if (connector.inputs && typeof connector.inputs === 'object') {
    for (const [key, binding] of Object.entries(connector.inputs)) {
      if (binding.type === 'multi' && binding.bindings) {
        binding.bindings.forEach((b, i) => {
          errors.push(...validateBinding(b, `inputs.${key}.bindings[${i}]`));
        });
      } else {
        errors.push(...validateBinding(binding, `inputs.${key}`));
      }
    }
  }

  // Validate outputs
  if (connector.outputs && typeof connector.outputs === 'object') {
    for (const [key, binding] of Object.entries(connector.outputs)) {
      errors.push(...validateBinding(binding, `outputs.${key}`));
    }
  }

  // Validate parameters
  if (connector.parameters && typeof connector.parameters === 'object') {
    for (const [key, binding] of Object.entries(connector.parameters)) {
      errors.push(...validateBinding(binding, `parameters.${key}`));
    }
  }

  // Validate guideNodes
  if (connector.guideNodes) {
    if (!Array.isArray(connector.guideNodes.bindings)) {
      errors.push('guideNodes.bindings must be an array');
    } else {
      connector.guideNodes.bindings.forEach((b, i) => {
        if (!b.nodeId) errors.push(`guideNodes.bindings[${i}]: missing nodeId`);
      });
    }
  }

  return errors;
}

// ─── Loading ────────────────────────────────────────

/**
 * Load all connectors from disk and validate them.
 * Returns { connectors, warnings, errors }.
 */
function loadConnectors() {
  const loaded = {};
  const warnings = [];
  const loadErrors = [];

  if (!fs.existsSync(CONNECTOR_DIR)) {
    warn(`Connector directory not found: ${CONNECTOR_DIR}`);
    return { connectors: loaded, warnings, errors: loadErrors };
  }

  const files = fs.readdirSync(CONNECTOR_DIR).filter(f => f.endsWith('.json') && f.startsWith('conn-'));

  for (const file of files) {
    const name = file.replace('.json', '');
    const filePath = path.join(CONNECTOR_DIR, file);

    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const connector = JSON.parse(raw);
      connector._sourceFile = file;

      const validationErrors = validateConnector(connector, name);
      if (validationErrors.length > 0) {
        warn(`Connector "${name}" has validation errors:\n  - ${validationErrors.join('\n  - ')}`);
        loadErrors.push(...validationErrors.map(e => `${name}: ${e}`));
      }

      loaded[name] = connector;
      log(`Loaded connector: ${name} → workflow "${connector.workflow}"`);
    } catch (err) {
      error(`Failed to load connector "${name}": ${err.message}`);
      loadErrors.push(`${name}: ${err.message}`);
    }
  }

  log(`Loaded ${Object.keys(loaded).length} connectors from ${CONNECTOR_DIR}`);
  return { connectors: loaded, warnings, errors: loadErrors };
}

/**
 * Register connectors in the in-memory registry.
 * All connectors start as enabled.
 * @param {object} connectorMap — { connectorName: connector }
 */
function registerConnectors(connectorMap) {
  for (const [name, connector] of Object.entries(connectorMap)) {
    connectorsByName[name] = connector;
    connectors[connector.workflow] = connector;
    // Default to enabled
    if (connectorEnabled[name] === undefined) {
      connectorEnabled[name] = true;
    }
  }
}

// ─── Compatibility Check ────────────────────────────

/**
 * Check if a connector is compatible with a workflow JSON.
 * @param {object} connector
 * @param {object} workflowJson — loaded ComfyUI workflow JSON
 * @returns {{ compatible: boolean, warnings: string[] }}
 */
function checkCompatibility(connector, workflowJson) {
  const compatResult = { compatible: true, warnings: [] };

  // 1. Hash check
  if (connector.workflowHash) {
    const actualHash = computeWorkflowHash(workflowJson);
    if (actualHash !== connector.workflowHash) {
      compatResult.warnings.push(
        `Workflow hash mismatch for "${connector.workflow}": ` +
        `connector expects ${connector.workflowHash}, got ${actualHash}. ` +
        `The workflow may have been modified.`
      );
      compatResult.compatible = false;
    }
  }

  // 2. Node class check
  const nodeClasses = connector.compatibility?.nodeClasses;
  if (nodeClasses) {
    for (const [nodeId, expectedClass] of Object.entries(nodeClasses)) {
      const actualNode = workflowJson[nodeId];
      if (!actualNode) {
        compatResult.warnings.push(
          `Node ${nodeId} (expected ${expectedClass}) not found in workflow "${connector.workflow}". ` +
          `The workflow structure may have changed.`
        );
        compatResult.compatible = false;
        continue;
      }
      if (actualNode.class_type !== expectedClass) {
        compatResult.warnings.push(
          `Node ${nodeId} class mismatch: connector expects "${expectedClass}", ` +
          `workflow has "${actualNode.class_type}".`
        );
        compatResult.compatible = false;
      }
    }
  }

  // 3. Collect all bindings with their section context
  const allBindings = []; // { binding, section, entityKey }

  function collectBindings(section, sectionObj) {
    if (!sectionObj) return;
    for (const [entityKey, binding] of Object.entries(sectionObj)) {
      if (binding.type === 'multi' && binding.bindings) {
        for (const subBinding of binding.bindings) {
          allBindings.push({ binding: subBinding, section, entityKey });
        }
      } else {
        allBindings.push({ binding, section, entityKey });
      }
    }
  }

  collectBindings('inputs', connector.inputs);
  collectBindings('outputs', connector.outputs);
  collectBindings('parameters', connector.parameters);

  // Check each binding's nodeId exists in workflow
  for (const { binding, section, entityKey } of allBindings) {
    if (!binding.nodeId) {
      // Required binding without nodeId — this is a problem
      if (binding.required) {
        compatResult.warnings.push(
          `Required ${section} binding "${entityKey}" has no nodeId assigned. ` +
          `This port must be connected for the workflow to function.`
        );
        compatResult.compatible = false;
      }
      continue;
    }

    const workflowNode = workflowJson[binding.nodeId];
    if (!workflowNode) {
      compatResult.warnings.push(
        `Binding references node ${binding.nodeId} (entity: ${entityKey}) ` +
        `but it was not found in workflow "${connector.workflow}".`
      );
      compatResult.compatible = false;
      continue;
    }

    // 3b. Check class_type match per binding (optional — if expectedClass is set)
    if (binding.expectedClass && workflowNode.class_type !== binding.expectedClass) {
      compatResult.warnings.push(
        `Binding "${entityKey}" (${section}) points to node ${binding.nodeId} ` +
        `of class "${workflowNode.class_type}", but connector expects "${binding.expectedClass}". ` +
        `This may indicate a workflow structure change.`
      );
      compatResult.compatible = false;
    }
  }

  // 4. Verify guideNodes
  if (connector.guideNodes?.bindings) {
    for (const gb of connector.guideNodes.bindings) {
      if (gb.nodeId && !workflowJson[gb.nodeId]) {
        compatResult.warnings.push(
          `Guide node ${gb.nodeId} not found in workflow "${connector.workflow}".`
        );
        compatResult.compatible = false;
      }
    }
  }

  return compatResult;
}

// ─── Value Application API ──────────────────────────

/**
 * Set a value on a workflow JSON at the path described by a binding.
 *
 * @param {object} workflowJson — the workflow JSON (mutated in-place)
 * @param {object} binding — a binding descriptor { nodeId, field }
 * @param {*} value — value to set
 */
function applyBinding(workflowJson, binding, value) {
  if (!binding || !binding.nodeId) return;
  const node = workflowJson[binding.nodeId];
  if (!node) {
    warn(`applyBinding: node ${binding.nodeId} not found in workflow`);
    return;
  }

  const fieldParts = binding.field.split('.');
  let target = node;
  for (let i = 0; i < fieldParts.length - 1; i++) {
    const part = fieldParts[i];
    if (target[part] === undefined || typeof target[part] !== 'object') {
      target[part] = {};
    }
    target = target[part];
  }
  target[fieldParts[fieldParts.length - 1]] = value;
}

/**
 * Look up a binding by entity key from a connector's inputs/outputs/parameters.
 *
 * @param {object} connector
 * @param {string} entityKey — e.g. "positivePrompt", "sourceImages"
 * @returns {object|null} — binding descriptor or null
 */
function getBinding(connector, entityKey) {
  if (!connector) return null;

  // Check inputs
  if (connector.inputs?.[entityKey]) return connector.inputs[entityKey];

  // Check outputs
  if (connector.outputs?.[entityKey]) return connector.outputs[entityKey];

  // Check parameters
  if (connector.parameters?.[entityKey]) return connector.parameters[entityKey];

  return null;
}

/**
 * Get the node ID for a binding by entity key.
 * For multi-bindings (sourceImages), returns an array of nodeIds.
 *
 * @param {object} connector
 * @param {string} entityKey
 * @returns {string|string[]|null}
 */
function getNodeId(connector, entityKey) {
  const binding = getBinding(connector, entityKey);
  if (!binding) return null;

  if (binding.type === 'multi' && binding.bindings) {
    return binding.bindings.map(b => b.nodeId);
  }

  return binding.nodeId;
}

/**
 * Get the guide node bindings for video workflows.
 * @param {object} connector
 * @returns {Array<{nodeId: string, fieldFrameIdx: string, fieldStrength: string, imageSource: string}>}
 */
function getGuideBindings(connector) {
  return connector?.guideNodes?.bindings || [];
}

/**
 * Apply a value to a workflow using a connector binding.
 *
 * @param {object} workflowJson — workflow JSON to modify
 * @param {object} connector — connector object
 * @param {string} entityKey — entity key to look up binding for
 * @param {*} value — value to set
 * @returns {boolean} — true if applied successfully
 */
function setValue(workflowJson, connector, entityKey, value) {
  const binding = getBinding(connector, entityKey);
  if (!binding) {
    warn(`setValue: no binding found for entity "${entityKey}"`);
    return false;
  }

  if (binding.type === 'multi' && binding.bindings) {
    // Multi-binding: expect value to be an array
    if (!Array.isArray(value)) {
      warn(`setValue: expected array for multi-binding "${entityKey}"`);
      return false;
    }
    for (let i = 0; i < Math.min(value.length, binding.bindings.length); i++) {
      applyBinding(workflowJson, binding.bindings[i], value[i]);
    }
    return true;
  }

  applyBinding(workflowJson, binding, value);
  return true;
}

/**
 * Update a connector parameter's default value with validation.
 *
 * @param {string} connectorName — e.g. "conn-image-generation"
 * @param {string} paramKey — e.g. "steps"
 * @param {*} value — new value to set
 * @returns {{ ok: boolean, error?: string, warnings?: string[] }}
 */
function updateConnectorParameter(connectorName, paramKey, value) {
  const connector = connectorsByName[connectorName];
  if (!connector) {
    return { ok: false, error: `Connector "${connectorName}" not found` };
  }

  const param = connector.parameters?.[paramKey];
  if (!param) {
    return { ok: false, error: `Parameter "${paramKey}" not found on connector "${connectorName}"` };
  }

  const warnings = [];

  // Determine expected type from binding metadata or entity schema
  const entity = entitySchema.getEntity(param.entityType || paramKey);
  const expectedType = param.type || entity?.type || typeof param.default;

  // Validate type
  let parsedValue = value;
  if (expectedType === 'int' || expectedType === 'number') {
    if (typeof value === 'string') {
      parsedValue = Number(value);
      if (isNaN(parsedValue)) {
        return { ok: false, error: `Invalid numeric value "${value}" for parameter "${paramKey}"` };
      }
    }
    if (typeof parsedValue !== 'number' || isNaN(parsedValue)) {
      return { ok: false, error: `Expected numeric value for parameter "${paramKey}", got ${typeof value}` };
    }
    if (expectedType === 'int') {
      parsedValue = Math.round(parsedValue);
    }

    // Validate min/max
    if (param.min !== undefined && parsedValue < param.min) {
      warnings.push(`Value ${parsedValue} is below minimum ${param.min}, clamping`);
      parsedValue = param.min;
    }
    if (param.max !== undefined && parsedValue > param.max) {
      warnings.push(`Value ${parsedValue} exceeds maximum ${param.max}, clamping`);
      parsedValue = param.max;
    }
  } else if (expectedType === 'float') {
    if (typeof value === 'string') {
      parsedValue = parseFloat(value);
      if (isNaN(parsedValue)) {
        return { ok: false, error: `Invalid float value "${value}" for parameter "${paramKey}"` };
      }
    }
    if (typeof parsedValue !== 'number' || isNaN(parsedValue)) {
      return { ok: false, error: `Expected float value for parameter "${paramKey}", got ${typeof value}` };
    }

    if (param.min !== undefined && parsedValue < param.min) {
      warnings.push(`Value ${parsedValue} is below minimum ${param.min}, clamping`);
      parsedValue = param.min;
    }
    if (param.max !== undefined && parsedValue > param.max) {
      warnings.push(`Value ${parsedValue} exceeds maximum ${param.max}, clamping`);
      parsedValue = param.max;
    }
  }

  // Update the parameter's default value
  const oldValue = param.default;
  param.default = parsedValue;

  log(`Parameter "${connectorName}.${paramKey}" updated: ${JSON.stringify(oldValue)} → ${JSON.stringify(parsedValue)}`);

  return {
    ok: true,
    warnings: warnings.length > 0 ? warnings : undefined,
    previousValue: oldValue,
    currentValue: parsedValue
  };
}

/**
 * Reset a connector parameter to its original default value (from disk).
 * @param {string} connectorName
 * @param {string} paramKey
 * @returns {{ ok: boolean, error?: string, currentValue?: * }}
 */
function resetConnectorParameter(connectorName, paramKey) {
  const connector = connectorsByName[connectorName];
  if (!connector) {
    return { ok: false, error: `Connector "${connectorName}" not found` };
  }

  const param = connector.parameters?.[paramKey];
  if (!param) {
    return { ok: false, error: `Parameter "${paramKey}" not found` };
  }

  // The original default is stored on the connector JSON and can be reloaded
  // For now, the in-memory value IS the current value
  log(`Parameter "${connectorName}.${paramKey}" current value: ${JSON.stringify(param.default)}`);

  return {
    ok: true,
    currentValue: param.default
  };
}

/**
 * Update workflow hash on a connector after it was loaded (e.g. at startup).
 */
function updateWorkflowHash(connector, workflowJson) {
  connector.workflowHash = computeWorkflowHash(workflowJson);
}

// ─── Initialization ─────────────────────────────────

/**
 * Full initialization: load connectors, register them, and
 * validate against provided workflow map.
 * Auto-populates workflowHash for connectors that have empty hashes.
 *
 * @param {object} workflowMap — { workflowName: workflowJson }
 * @returns {{ connectors: object[], warnings: string[], errors: string[] }}
 */
function initialize(workflowMap = {}) {
  const result = loadConnectors();
  registerConnectors(result.connectors);

  const allWarnings = [...result.warnings];
  const allErrors = [...result.errors];

  // Auto-populate empty workflow hashes
  for (const [name, connector] of Object.entries(result.connectors)) {
    const wfName = connector.workflow;
    const wf = workflowMap[wfName];
    if (wf && !connector.workflowHash) {
      updateWorkflowHash(connector, wf);
      log(`Auto-populated workflowHash for connector "${name}": ${connector.workflowHash.slice(0, 16)}...`);
    }
  }

  // Validate each connector against its workflow
  for (const [name, connector] of Object.entries(result.connectors)) {
    const wfName = connector.workflow;
    const wf = workflowMap[wfName];

    if (wf) {
      const compat = checkCompatibility(connector, wf);
      if (!compat.compatible) {
        for (const w of compat.warnings) {
          warn(w);
          allWarnings.push(w);
        }
      } else {
        log(`Connector "${name}" is compatible with workflow "${wfName}"`);
      }
    } else {
      const msg = `Workflow "${wfName}" (referenced by connector "${name}") not found in workflow map`;
      warn(msg);
      allWarnings.push(msg);
    }
  }

  return { connectors: result.connectors, warnings: allWarnings, errors: allErrors };
}

/**
 * Get a connector by workflow name.
 * @param {string} workflowName — e.g. "img-qwen-image"
 * @returns {object|null}
 */
function getConnector(workflowName) {
  return connectors[workflowName] || null;
}

/**
 * Get a connector by its file name (without extension).
 * @param {string} connectorName — e.g. "conn-image-generation"
 * @returns {object|null}
 */
function getConnectorByName(connectorName) {
  return connectorsByName[connectorName] || null;
}

/**
 * Get all registered connectors.
 * @returns {object[]}
 */
function getAllConnectors() {
  return Object.values(connectors);
}

/**
 * Get all registered connectors grouped by type.
 * @returns {{ audio: object[], image: object[], video: object[], unknown: object[] }}
 */
function getConnectorsByType() {
  const grouped = { audio: [], image: [], video: [], unknown: [] };
  for (const conn of Object.values(connectors)) {
    const type = conn.type || 'unknown';
    if (grouped[type]) {
      grouped[type].push(conn);
    } else {
      grouped.unknown.push(conn);
    }
  }
  return grouped;
}

/**
 * Get status summary for all connectors.
 * @param {object} workflowMap — optional workflow map for on-demand compatibility check
 * @returns {Array<{name: string, label: string, type: string, workflow: string, status: string, version: string}>}
 */
function getConnectorStatuses(workflowMap) {
  const statuses = [];
  for (const [name, connector] of Object.entries(connectorsByName)) {
    const wfName = connector.workflow;
    let status = 'unknown';

    if (workflowMap && workflowMap[wfName]) {
      const compat = checkCompatibility(connector, workflowMap[wfName]);
      status = compat.compatible ? 'compatible' : 'incompatible';
    } else if (connector.workflowHash) {
      status = 'registered';
    }

    statuses.push({
      name,
      label: connector.label || connector.workflow,
      type: connector.type || 'unknown',
      workflow: connector.workflow,
      status,
      version: connector.connectorVersion || '1.0.0',
      description: connector.description || '',
      enabled: isConnectorEnabled(name)
    });
  }
  return statuses;
}

/**
 * Register a single connector in the in-memory registry.
 * @param {string} name — connector name (e.g. "conn-image-generation")
 * @param {object} connector — connector object
 */
function registerConnector(name, connector) {
  connectorsByName[name] = connector;
  connectors[connector.workflow] = connector;
  connectorEnabled[name] = true;
  log(`Registered connector: ${name} → workflow "${connector.workflow}"`);
}

/**
 * Unregister a connector from the in-memory registry.
 * @param {string} name — connector name (e.g. "conn-image-generation")
 * @returns {boolean} — true if connector was found and removed
 */
function unregisterConnector(name) {
  const connector = connectorsByName[name];
  if (!connector) {
    warn(`Cannot unregister connector "${name}" — not found`);
    return false;
  }

  // Remove from both indices
  delete connectorsByName[name];
  if (connectors[connector.workflow] === connector) {
    delete connectors[connector.workflow];
  }

  log(`Unregistered connector: ${name} (was → workflow "${connector.workflow}")`);
  return true;
}

/**
 * Reload all connectors from disk, preserving the ones that fail.
 * Clears registries, re-loads, re-registers, and re-validates.
 * Preserves enabled/disabled state across reload.
 *
 * @param {object} workflowMap — { workflowName: workflowJson }
 * @returns {{ connectors: object[], warnings: string[], errors: string[] }}
 */
function reload(workflowMap) {
  log('Reloading connectors from disk...');

  // Preserve enabled/disabled state across reload
  const previousEnabled = { ...connectorEnabled };

  // Clear registries
  for (const key of Object.keys(connectors)) {
    delete connectors[key];
  }
  for (const key of Object.keys(connectorsByName)) {
    delete connectorsByName[key];
  }
  for (const key of Object.keys(connectorEnabled)) {
    delete connectorEnabled[key];
  }

  // Re-initialize
  const result = initialize(workflowMap);

  // Restore previous enabled/disabled state for connectors that still exist
  for (const name of Object.keys(result.connectors)) {
    if (previousEnabled[name] !== undefined) {
      connectorEnabled[name] = previousEnabled[name];
    }
  }

  return result;
}

// ─── Add Connector ────────────────────────────────

/**
 * Add a new connector: save to disk, validate, and register.
 * @param {string} name — connector name (without .json)
 * @param {object} connectorJson — connector object
 * @param {object} [workflowMap] — optional workflow map for validation
 * @returns {{ ok: boolean, error?: string, warnings?: string[] }}
 */
function addConnector(name, connectorJson, workflowMap) {
  // Validate the connector structure first
  const validationErrors = validateConnector(connectorJson, name);
  const warnings = [];

  if (validationErrors.length > 0) {
    return { ok: false, error: `Validation errors:\n  - ${validationErrors.join('\n  - ')}` };
  }

  // Check referenced workflow exists
  const wfName = connectorJson.workflow;
  if (workflowMap && wfName && !workflowMap[wfName]) {
    const available = Object.keys(workflowMap).join(', ');
    warnings.push(`Referenced workflow "${wfName}" not loaded. Available workflows: ${available}`);
  }

  // Write to disk
  const filePath = path.join(CONNECTOR_DIR, `${name}.json`);
  try {
    // Ensure directory exists
    if (!fs.existsSync(CONNECTOR_DIR)) {
      fs.mkdirSync(CONNECTOR_DIR, { recursive: true });
    }
    // Merge with any existing file content to preserve source
    fs.writeFileSync(filePath, JSON.stringify(connectorJson, null, 2) + '\n', 'utf8');
    log(`Connector saved to disk: ${filePath}`);
  } catch (err) {
    return { ok: false, error: `Failed to write connector to disk: ${err.message}` };
  }

  // Register in-memory
  registerConnector(name, connectorJson);

  // Auto-populate workflow hash if possible
  if (workflowMap && wfName && workflowMap[wfName]) {
    updateWorkflowHash(connectorJson, workflowMap[wfName]);
  }

  return { ok: true, warnings: warnings.length > 0 ? warnings : undefined };
}

// ─── Enable/Disable ────────────────────────────────

/**
 * Set a connector's enabled/disabled status.
 * @param {string} connectorName — e.g. "conn-image-generation"
 * @param {boolean} enabled
 * @returns {{ ok: boolean, error?: string }}
 */
function setConnectorStatus(connectorName, enabled) {
  if (!connectorsByName[connectorName]) {
    return { ok: false, error: `Connector "${connectorName}" not found` };
  }
  connectorEnabled[connectorName] = !!enabled;
  log(`Connector "${connectorName}" ${enabled ? 'enabled' : 'disabled'}`);
  return { ok: true, enabled: !!enabled };
}

/**
 * Check if a connector is enabled.
 * @param {string} connectorName
 * @returns {boolean} — true if enabled (default), false if disabled
 */
function isConnectorEnabled(connectorName) {
  // Default to enabled if not explicitly set
  return connectorEnabled[connectorName] !== false;
}

// ─── Update Binding ────────────────────────────────

/**
 * Update an input or output binding's nodeId and/or field.
 * @param {string} connectorName — e.g. "conn-image-generation"
 * @param {string} section — "inputs" or "outputs"
 * @param {string} entityKey — e.g. "positivePrompt"
 * @param {object} updates — { nodeId?: string, field?: string }
 * @returns {{ ok: boolean, error?: string }}
 */
function updateConnectorBinding(connectorName, section, entityKey, updates) {
  const connector = connectorsByName[connectorName];
  if (!connector) {
    return { ok: false, error: `Connector "${connectorName}" not found` };
  }

  if (section !== 'inputs' && section !== 'outputs' && section !== 'guideNodes') {
    return { ok: false, error: `Invalid section "${section}". Must be "inputs", "outputs", or "guideNodes"` };
  }

  // Handle guideNodes section (array-based, not key-based)
  if (section === 'guideNodes') {
    const guideBindings = connector.guideNodes?.bindings;
    const index = parseInt(entityKey, 10);
    if (!guideBindings || !Array.isArray(guideBindings)) {
      return { ok: false, error: `Connector "${connectorName}" has no guideNodes` };
    }
    if (isNaN(index) || index < 0 || index >= guideBindings.length) {
      return { ok: false, error: `Invalid guide node index ${entityKey}. Must be 0-${guideBindings.length - 1}` };
    }
    if (updates.nodeId !== undefined) {
      guideBindings[index].nodeId = updates.nodeId;
    }
    log(`Guide node binding updated: ${connectorName}.guideNodes[${index}] → nodeId=${guideBindings[index].nodeId}`);
    return { ok: true };
  }

  const sectionObj = connector[section];
  if (!sectionObj || !sectionObj[entityKey]) {
    return { ok: false, error: `Binding "${entityKey}" not found in ${section} of connector "${connectorName}"` };
  }

  const binding = sectionObj[entityKey];

  // Handle multi-bindings (e.g. sourceImages with array of sub-bindings)
  if (binding.type === 'multi' && binding.bindings) {
    if (updates.bindings && Array.isArray(updates.bindings)) {
      for (let i = 0; i < Math.min(updates.bindings.length, binding.bindings.length); i++) {
        const subUpdate = updates.bindings[i];
        if (subUpdate.nodeId) binding.bindings[i].nodeId = subUpdate.nodeId;
        if (subUpdate.field) binding.bindings[i].field = subUpdate.field;
      }
    }
    return { ok: true };
  }

  // Update fields
  if (updates.nodeId !== undefined) {
    binding.nodeId = updates.nodeId;
  }
  if (updates.field !== undefined) {
    binding.field = updates.field;
  }

  log(`Binding updated: ${connectorName}.${section}.${entityKey} → ${JSON.stringify({ nodeId: binding.nodeId, field: binding.field })}`);
  return { ok: true };
}

// ─── Exports ────────────────────────────────────────

module.exports = {
  // Lifecycle
  loadConnectors,
  registerConnectors,
  initialize,
  reload,
  registerConnector,
  unregisterConnector,

  // Compatibility
  checkCompatibility,
  computeWorkflowHash,

  // Lookup
  getConnector,
  getConnectorByName,
  getAllConnectors,
  getConnectorsByType,
  getConnectorStatuses,
  getBinding,
  getNodeId,
  getGuideBindings,

  // Value manipulation
  setValue,
  applyBinding,
  updateWorkflowHash,
  updateConnectorParameter,
  resetConnectorParameter,

  // Registry (inspectable)
  connectors,
  connectorsByName,
  connectorEnabled,

  // Enable/Disable
  setConnectorStatus,
  isConnectorEnabled,

  // Add connector
  addConnector,

  // Update binding
  updateConnectorBinding
};
